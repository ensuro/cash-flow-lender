// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.16;

import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {ERC2771ContextUpgradeable} from "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";
import {ContextUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/interfaces/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/interfaces/IERC721Receiver.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Packing} from "@openzeppelin/contracts/utils/Packing.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IPolicyPool} from "./dependencies/IPolicyPool.sol";
import {IRiskModule} from "./dependencies/IRiskModule.sol";
import {IPolicyHolder} from "@ensuro/core/contracts/interfaces/IPolicyHolder.sol";
import {Policy} from "@ensuro/core/contracts/Policy.sol";
import {AccessManagedProxy} from "@ensuro/access-managed-proxy/contracts/AccessManagedProxy.sol";
import {AMPUtils} from "@ensuro/access-managed-proxy/contracts/AMPUtils.sol";

/**
 * @title CashFlow Lender Module that tracks ownership
 * @dev Implements the ERC-4626 standard tracking how much liquidity was provided by each LP.
 *      The assets managed by the vault are a mix of liquid USDC + the $._totalDebt tracked by the CFL.
 *
 *      The debt is tracked as a global number, but also for each target and period (month for example). If the debt
 *      is negative, it means Ensuro owes to the customer.
 *
 *      The funds can also be sent to a $._yieldVault to generate yields on the idle funds.
 *
 *      The contract forwards the calls to the targets (Ensuro risk modules), but it has two variants for doing that
 *      a. forwardNewPolicy (and the batch variant): this method tracks the balance reduction caused by paying the
 *         premiums, and in base of that number increases the debt.
 *      b. forwardResolvePolicy (and the batch variant): this method just forwards the call (after doing access
 *         validations). The debt will be reduced when the policies are resolved and the PolicyPool calls
 *         `onPayoutReceived(...)`
 *
 *      The contract is a UUPSUpgradeable contract but MUST NOT be used with a plain ERC1967 proxy, but instead with
 *      an `AccessManagedProxy` that executes the access control. The contract DOESN'T IMPLEMENT ACCESS CONTROL
 *      validations on the critical methods. It's assumed it will be deployed behind an AccessManagedProxy with
 *      the proper access control setup.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract CashFlowLender is ERC2771ContextUpgradeable, UUPSUpgradeable, ERC4626Upgradeable, IPolicyHolder, ERC165 {
  using SafeERC20 for IERC20Metadata;
  using SafeCast for uint256;
  using SafeCast for int256;
  using Address for address;

  bytes4 public constant OWN_POLICY_SELECTOR = 0xffffffff;

  /**
   * @dev Slot size used to indicate the slots use calendar months.
   *      Only years from 2025 to 2099 are supported
   */
  uint32 public constant SLOTSIZE_CALENDAR_MONTH = type(uint32).max;

  uint256 internal constant JAN_1ST_2025 = 1735689600;
  uint256 internal constant SECONDS_PER_DAY = 86400;

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IPolicyPool internal immutable _policyPool;

  /**
   * @dev The target slot is the (address target, uint32 slotSize, uint32 slotIndex) packed in a bytes32
   *      The slotIndex is defined as block.timestamp / slotSize for non calendar month slots or as year*100 + month
   *      for calendar month slots.
   *      For example, the slot for Jan 2026 is 202601
   */
  type TargetSlot is bytes32; // (target_address, slotSize, block.timestamp / slotSize) packed as bytes32

  /**
   * @dev This status defines what kind of operations are enabled for a given target
   */
  enum TargetStatus {
    inactive, // Nothing accepted
    active, // Everything accepted
    deprecated, // Only resolutions accepted
    suspended // Nothing accepted
  }

  struct TargetConfig {
    uint32 slotSize;
    TargetStatus status;
    uint96 debtLimit; // Max debt in a given period
    uint96 minLiquidity; // Minimum cash required before a batch of new policies
  }

  /// @custom:storage-location erc7201:ensuro.storage.CashFlowLender
  struct CashFlowLenderStorage {
    IERC4626 _yieldVault;
    int96 _totalDebt;
    mapping(address => TargetConfig) _targets;
    mapping(TargetSlot => int256) _debtByPeriod;
  }

  // keccak256(abi.encode(uint256(keccak256("ensuro.storage.CashFlowLender")) - 1)) & ~bytes32(uint256(0xff))
  // solhint-disable-next-line const-name-snakecase
  bytes32 internal constant CashFlowLenderStorageLocation =
    0x0dff660c705ec490383ffafc9e8e3ab4714559f9ec8567c5380d4ad2dff5af00;

  function _getCashFlowLenderStorage() internal pure returns (CashFlowLenderStorage storage $) {
    // solhint-disable-next-line no-inline-assembly
    assembly {
      $.slot := CashFlowLenderStorageLocation
    }
  }

  event YieldVaultChanged(IERC4626 oldVault, IERC4626 newVault);
  event DebtChanged(
    address indexed target,
    uint32 slotSize,
    uint32 slotIndex,
    int256 value,
    int256 debtAfterChange,
    int256 totalDebtAfterChange
  );
  event CashOutPayout(
    address indexed target,
    uint32 slotSize,
    uint32 slotIndex,
    uint256 amount,
    int256 debtAfterChange,
    address destination
  );
  event RepayDebt(
    address indexed target,
    uint32 slotSize,
    uint32 slotIndex,
    uint256 amount,
    int256 debtAfterChange,
    address payer
  );
  event TargetAdded(address indexed target, TargetConfig config);
  event TargetLimitsChanged(
    address indexed target,
    uint256 oldDebtLimit,
    uint256 newDebtLimit,
    uint256 oldMinLiquidity,
    uint256 newMinLiquidity
  );
  event TargetStatusChanged(address indexed target, TargetStatus oldStatus, TargetStatus newStatus);
  event TargetSlotSizeChanged(address indexed target, uint32 oldSlotSize, uint32 newSlotSize);

  error InvalidPolicyPool();
  error OnlyPolicyPool(address sender);
  error TargetNotActive(address target, TargetStatus status);
  error CannotDeactivateTarget();
  error TargetAlreadyExists();
  error InvalidSlotSize();
  error DebtLimitExceeded(int256 currentDebt, uint96 debtLimit);
  error UnauthorizedForward(address caller, address target, bytes4 requiredSelector);
  error BalanceDecreasedOnResolve(uint256 balanceReduction);
  error YieldVaultIsRequired();
  error NotEnoughCash();
  error TargetNotFound(address target);
  error CashOutExceedsLimit(uint256 amount, int256 debtAfter);
  error RepaymentExceedsLimit(uint256 amount, int256 debtAfter);
  error CannotDeinvestYieldVault();

  modifier onlyPolicyPool() {
    // I intentionally use msg.sender instead of _msgSender() because I know the PolicyPool won't call
    // via the forwarded.
    require(msg.sender == address(_policyPool), OnlyPolicyPool(msg.sender));
    _;
  }

  modifier forwardNewPolicyWrapper(address target) {
    TargetConfig storage targetConfig = _getTargetConfig(target);
    require(targetConfig.status == TargetStatus.active, TargetNotActive(target, targetConfig.status));

    // Measure the balance change
    uint256 balanceBefore = _ensureLiquidBalance(targetConfig);
    _;
    _increaseDebtAfterNewPolicy(target, targetConfig, balanceBefore);
  }

  modifier forwardResolvePolicyWrapper(address target) {
    TargetConfig storage targetConfig = _getTargetConfig(target);
    require(
      targetConfig.status == TargetStatus.active || targetConfig.status == TargetStatus.deprecated,
      TargetNotActive(target, targetConfig.status)
    );

    // Measure the balance change to check it doesn't goes down
    uint256 balanceBefore = _balance();
    _;
    uint256 balanceAfter = _balance();

    if (balanceAfter < balanceBefore) {
      revert BalanceDecreasedOnResolve(balanceBefore - balanceAfter);
    }
  }

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(address trustedForwarder_, IPolicyPool policyPool_) ERC2771ContextUpgradeable(trustedForwarder_) {
    _policyPool = policyPool_;
    _disableInitializers();
  }

  /**
   * @dev Initializes the CashFlowLender
   *
   * @param name_ Name of the accounting token (ERC20) for the LPs
   * @param symbol_ Symbol of the accounting token (ERC20) for the LPs
   * @param yieldVault_ An ERC-4626 vault where funds can be deployed to generate extra yields for the CFL LPs.
   */
  function initialize(string memory name_, string memory symbol_, IERC4626 yieldVault_) public virtual initializer {
    __CashFlowLender_init(name_, symbol_, yieldVault_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __CashFlowLender_init(
    string memory name_,
    string memory symbol_,
    IERC4626 yieldVault_
  ) internal onlyInitializing {
    address asset_ = address(_policyPool.currency());
    __ERC4626_init(IERC20(asset_));
    __ERC20_init(name_, symbol_);
    __CashFlowLender_init_unchained(yieldVault_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __CashFlowLender_init_unchained(IERC4626 yieldVault_) internal onlyInitializing {
    // Infinite approval to the PolicyPool to pay the premiums
    _policyPool.currency().approve(address(_policyPool), type(uint256).max);
    _setYieldVault(yieldVault_);
  }

  function _setYieldVault(IERC4626 yieldVault_) internal {
    require(address(yieldVault_) != address(0), YieldVaultIsRequired());
    // I explicitly avoid checking yieldVault_.asset() == asset().
    // This is to support migration of the asset (from USDC bridged to USDC native) that is on the roadmap
    // Only temporarily, during a migration we might have that difference
    CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
    IERC4626 oldVault = $._yieldVault;
    $._yieldVault = yieldVault_;
    if (address(oldVault) != address(0)) IERC20Metadata(asset()).approve(address(oldVault), 0);
    IERC20Metadata(asset()).approve(address(yieldVault_), type(uint256).max);
    emit YieldVaultChanged(oldVault, yieldVault_);
  }

  /**
   * @dev Changes the Yield Vault, deinvesting all the funds before doing it.
   *
   * @param yieldVault_ An ERC-4626 vault where funds can be deployed to generate extra yields for the CFL LPs.
   * @param force If true, it continues the operation even if some of the funds aren't withdrawable.
   *
   * Emits a {YieldVaultChanged} event
   */
  function setYieldVault(IERC4626 yieldVault_, bool force) external {
    CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
    uint256 yieldAssets = $._yieldVault.convertToAssets($._yieldVault.balanceOf(address(this)));
    require(_deinvest(yieldAssets) == yieldAssets || force, CannotDeinvestYieldVault());
    _setYieldVault(yieldVault_);
  }

  function yieldVault() external view returns (IERC4626) {
    return _getCashFlowLenderStorage()._yieldVault;
  }

  function policyPool() external view returns (IPolicyPool) {
    return _policyPool;
  }

  function _getTargetConfig(address target) internal view returns (TargetConfig storage targetConfig) {
    CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
    targetConfig = $._targets[target];
    require(targetConfig.status != TargetStatus.inactive, TargetNotFound(target));
  }

  /**
   * @dev Adds a new target that can be used later to forward policies and track the debt.
   *
   * @param target Address of the target contract. It should be an Ensuro's RiskModule
   * @param slotSize Duration in seconds of the slots used to track the debt. The debt uses UTC aligned slots.
   * @param debtLimit Limit of the debt in a given period for the target.
   * @param minLiquidity Minimum liquidity tried to achieve before forwardNewPolicy. If cash (see `_balance()`) is
   *                     lower than this amount, it will try to deinvest the funds to leave _balance() = minLiquidity
   *
   * Emits a {TargetAdded} event
   */
  function addTarget(address target, uint32 slotSize, uint256 debtLimit, uint256 minLiquidity) external {
    CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
    TargetConfig storage targetConfig = $._targets[target];
    require(targetConfig.status == TargetStatus.inactive, TargetAlreadyExists());
    require(slotSize != 0, InvalidSlotSize());
    $._targets[target] = TargetConfig({
      status: TargetStatus.active,
      slotSize: slotSize,
      debtLimit: debtLimit.toUint96(),
      minLiquidity: minLiquidity.toUint96()
    });
    emit TargetAdded(target, targetConfig);
  }

  /**
   * @dev Changes debtLimit and minLiquidity for a given target.
   *
   * @param target Address of the target contract. It must be one previously added with {addTarget}.
   * @param debtLimit New limit of the debt in a given period for the target.
   * @param minLiquidity Minimum liquidity tried to achieve before forwardNewPolicy. If cash (see `_balance()`) is
   *                     lower than this amount, it will try to deinvest the funds to leave _balance() = minLiquidity
   *
   * Emits a {TargetLimitsChanged} event
   */
  function setTargetLimits(address target, uint256 debtLimit, uint256 minLiquidity) external {
    TargetConfig storage targetConfig = _getTargetConfig(target);
    emit TargetLimitsChanged(target, targetConfig.debtLimit, debtLimit, targetConfig.minLiquidity, minLiquidity);
    targetConfig.debtLimit = debtLimit.toUint96();
    targetConfig.minLiquidity = minLiquidity.toUint96();
  }

  /**
   * @dev Changes status of a given target. See {TargetStatus}.
   *
   * @param target Address of the target contract. It must be one previously added with {addTarget}.
   * @param newStatus The new status of the contract
   *
   * Emits a {TargetStatusChanged} event
   */
  function setTargetStatus(address target, TargetStatus newStatus) external {
    // Check the newStatus != inactive. If you want to disable a target, move it to suspended
    require(newStatus != TargetStatus.inactive, CannotDeactivateTarget());
    TargetConfig storage targetConfig = _getTargetConfig(target);
    emit TargetStatusChanged(target, targetConfig.status, newStatus);
    targetConfig.status = newStatus;
  }

  function getTargetStatus(address target) external view returns (TargetStatus) {
    CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
    return $._targets[target].status;
  }

  /**
   * @dev Changes the slotSize of a given target.
   *
   * @param target Address of the target contract. It must be one previously added with {addTarget}.
   * @param newSlotSize New duration in seconds of the slots used to track the debt. The debt uses UTC aligned slots.
   *
   * Emits a {TargetStatusChanged} event
   */
  function setTargetSlotSize(address target, uint32 newSlotSize) external {
    require(newSlotSize != 0, InvalidSlotSize());
    TargetConfig storage targetConfig = _getTargetConfig(target);
    emit TargetSlotSizeChanged(target, targetConfig.slotSize, newSlotSize);
    targetConfig.slotSize = newSlotSize;
  }

  /// @inheritdoc ERC165
  function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
    return
      interfaceId == type(IERC721Receiver).interfaceId ||
      interfaceId == type(IPolicyHolder).interfaceId ||
      interfaceId == type(IERC20).interfaceId ||
      interfaceId == type(IERC20Metadata).interfaceId ||
      interfaceId == type(IERC4626).interfaceId ||
      super.supportsInterface(interfaceId);
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address newImpl) internal view override {}

  /// @inheritdoc IERC721Receiver
  function onERC721Received(
    address,
    address,
    uint256,
    bytes calldata
  ) external view override onlyPolicyPool returns (bytes4) {
    return IERC721Receiver.onERC721Received.selector;
  }

  /// @inheritdoc IPolicyHolder
  function onPolicyExpired(address, address, uint256) external view override onlyPolicyPool returns (bytes4) {
    return IPolicyHolder.onPolicyExpired.selector;
  }

  /// @inheritdoc IPolicyHolder
  function onPayoutReceived(
    address operator,
    address,
    uint256,
    uint256 amount
  ) external override onlyPolicyPool returns (bytes4) {
    // In the PolicyPool the `operator` == _msgSender() for the payout call is the Risk Module, so, it's the same
    // target we called on newPolicy.
    TargetConfig storage targetConfig = _getTargetConfig(operator);
    require(
      targetConfig.status == TargetStatus.active || targetConfig.status == TargetStatus.deprecated,
      TargetNotActive(operator, targetConfig.status)
    );
    _changeDebt(
      operator,
      targetConfig.slotSize,
      _makeSlotIndex(targetConfig.slotSize, block.timestamp),
      -amount.toInt256()
    );
    return IPolicyHolder.onPayoutReceived.selector;
  }

  /// @inheritdoc IPolicyHolder
  function onPolicyReplaced(address, address, uint256, uint256) external view override onlyPolicyPool returns (bytes4) {
    return IPolicyHolder.onPolicyReplaced.selector;
  }

  /// @inheritdoc IPolicyHolder
  function onPolicyCancelled(
    address operator,
    address,
    uint256,
    uint256 purePremiumRefund,
    uint256 jrCocRefund,
    uint256 srCocRefund
  ) external override onlyPolicyPool returns (bytes4) {
    // In the PolicyPool the `operator` == _msgSender() for the cancel call is the Risk Module, so, it's the same
    // target we called on newPolicy.
    TargetConfig storage targetConfig = _getTargetConfig(operator);
    require(
      targetConfig.status == TargetStatus.active || targetConfig.status == TargetStatus.deprecated,
      TargetNotActive(operator, targetConfig.status)
    );
    uint256 totalRefund = purePremiumRefund + jrCocRefund + srCocRefund;
    _changeDebt(
      operator,
      targetConfig.slotSize,
      _makeSlotIndex(targetConfig.slotSize, block.timestamp),
      -totalRefund.toInt256()
    );
    return IPolicyHolder.onPolicyCancelled.selector;
  }

  // Fix Context base contract duplicates

  /// @inheritdoc ERC2771ContextUpgradeable
  function _contextSuffixLength()
    internal
    view
    override(ContextUpgradeable, ERC2771ContextUpgradeable)
    returns (uint256)
  {
    return ERC2771ContextUpgradeable._contextSuffixLength();
  }

  /// @inheritdoc ERC2771ContextUpgradeable
  function _msgSender() internal view override(ContextUpgradeable, ERC2771ContextUpgradeable) returns (address) {
    return ERC2771ContextUpgradeable._msgSender();
  }

  /// @inheritdoc ERC2771ContextUpgradeable
  function _msgData() internal view override(ContextUpgradeable, ERC2771ContextUpgradeable) returns (bytes calldata) {
    return ERC2771ContextUpgradeable._msgData();
  }

  function _balance() internal view returns (uint256) {
    return IERC20Metadata(asset()).balanceOf(address(this));
  }

  function _getMonth(uint256 dayInYear, bool isLeap) internal pure returns (uint256) {
    // Method implemented as a table instead of a loop for gas savings.
    // Saves around 300 gas per call.
    if (dayInYear < 31) return 1;
    if (isLeap) {
      if (dayInYear < 60) return 2;
      dayInYear--;
    } else {
      if (dayInYear < 59) return 2;
    }
    return
      (dayInYear < 90)
        ? 3
        : (dayInYear < 120)
          ? 4
          : (dayInYear < 151)
            ? 5
            : (dayInYear < 181)
              ? 6
              : (dayInYear < 212)
                ? 7
                : (dayInYear < 243)
                  ? 8
                  : (dayInYear < 273)
                    ? 9
                    : (dayInYear < 304)
                      ? 10
                      : (dayInYear < 334)
                        ? 11
                        : 12;
  }

  function _computeCalendarMonth(uint256 timestamp) internal pure returns (uint32 slotIndex) {
    bool isLeap;
    slotIndex = 2025;
    uint256 daysRemaining = (timestamp - JAN_1ST_2025) / SECONDS_PER_DAY;

    // Iterate through years to find the correct year
    while (daysRemaining >= (isLeap ? 366 : 365)) {
      daysRemaining -= isLeap ? 366 : 365;
      ++slotIndex;
      isLeap = slotIndex % 4 == 0 && (slotIndex % 100 != 0 || slotIndex % 400 == 0);
    }
    return uint32(slotIndex * 100 + _getMonth(daysRemaining, isLeap));
  }

  function _makeSlotIndex(uint32 slotSize, uint256 timestamp) internal pure returns (uint32 slotIndex) {
    return (slotSize == SLOTSIZE_CALENDAR_MONTH) ? _computeCalendarMonth(timestamp) : uint32(timestamp / slotSize);
  }

  function _makeTargetSlot(address target, uint32 slotSize, uint32 slotIndex) internal pure returns (TargetSlot slot) {
    return TargetSlot.wrap(Packing.pack_20_8(bytes20(target), Packing.pack_4_4(bytes4(slotSize), bytes4(slotIndex))));
  }

  function _deinvest(uint256 amount) internal returns (uint256 deinvested) {
    CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
    deinvested = Math.min(amount, $._yieldVault.maxWithdraw(address(this)));
    $._yieldVault.withdraw(deinvested, address(this), address(this));
  }

  function _changeDebt(
    address target,
    uint32 slotSize,
    uint32 slotIndex,
    int256 amount
  ) internal returns (int256 currentDebt_) {
    CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
    TargetSlot slot = _makeTargetSlot(target, slotSize, slotIndex);
    currentDebt_ = $._debtByPeriod[slot] += amount;
    $._totalDebt += int96(amount);
    emit DebtChanged(target, slotSize, slotIndex, int256(amount), currentDebt_, $._totalDebt);
  }

  /**
   * @dev Computes a fake selector used to enable or disable in the AccessManager linked to the contract to enable
   *      a given call (selector) to a given target
   *
   * @param target Address of the target contract.
   * @param selector The 4-bytes method selector of the method to be called in the target
   */
  function makeFakeSelector(address target, bytes4 selector) public pure returns (bytes4) {
    return AMPUtils.makeSelector(abi.encodePacked(target, selector));
  }

  function _ensureLiquidBalance(TargetConfig storage targetConfig) internal returns (uint256 balanceBefore) {
    // Measure the balance change
    balanceBefore = _balance();

    if (balanceBefore < uint256(targetConfig.minLiquidity)) {
      _deinvest(uint256(targetConfig.minLiquidity) - balanceBefore);
      balanceBefore = _balance();
    }
  }

  function _increaseDebtAfterNewPolicy(
    address target,
    TargetConfig storage targetConfig,
    uint256 balanceBefore
  ) internal {
    uint256 balanceAfter = _balance();

    if (balanceAfter < balanceBefore) {
      // Should always increase the debt, but just in case...
      int256 currDebt = _changeDebt(
        target,
        targetConfig.slotSize,
        _makeSlotIndex(targetConfig.slotSize, block.timestamp),
        (balanceBefore - balanceAfter).toInt256()
      );
      require(currDebt <= int256(uint256(targetConfig.debtLimit)), DebtLimitExceeded(currDebt, targetConfig.debtLimit));
    }
  }

  function _checkCanForward(address caller, address target, bytes4 selector) internal view {
    bytes4 fakeSelector = makeFakeSelector(target, selector);
    (bool immediate, ) = AccessManagedProxy(payable(address(this))).ACCESS_MANAGER().canCall(
      caller,
      address(this),
      fakeSelector
    );
    require(immediate, UnauthorizedForward(caller, target, fakeSelector));
  }

  function forwardNewPolicyV3(
    address target,
    bytes calldata inputData,
    address onBehalfOf
  ) external forwardNewPolicyWrapper(target) returns (Policy.PolicyData memory policy) {
    _checkCanForward(_msgSender(), target, bytes4(IRiskModule.newPolicy.selector));
    if (onBehalfOf != address(this)) _checkCanForward(_msgSender(), target, OWN_POLICY_SELECTOR);
    return IRiskModule(target).newPolicy(inputData, onBehalfOf);
  }

  function forwardNewPoliciesV3(
    address target,
    bytes[] calldata inputData,
    address onBehalfOf
  ) external forwardNewPolicyWrapper(target) {
    _checkCanForward(_msgSender(), target, bytes4(IRiskModule.newPolicy.selector));
    if (onBehalfOf != address(this)) _checkCanForward(_msgSender(), target, OWN_POLICY_SELECTOR);
    IRiskModule(target).newPolicies(inputData, onBehalfOf);
  }

  /**
   * @dev Forwards a call to the target contract, previously checking the target is active and tracking the increased
   *      debt (in the current time slot).
   *
   *      When the `_balance()` is lower than `targetConfig.minLiquidity` it deinvests, but it doesn't fail if can't
   *      deinvest all the required funds. If the required premiums are higher than the available balance, then it
   *      will fail anyway.
   *
   *      If after the operation the debt is higher than targetConfig.debtLimit, it reverts.
   *
   *      Requires the _msgSender() has permission to call address(this) on the fakeSelector (see {makeFakeSelector})
   *
   *      Requires the return value of the called function returns the policyId and checks if the resulting policy
   *      (a PolicyPool NFT), is owned by the CFL.
   *      If it's not, it requires the _msgSender() has permission to call address(this) on
   *      `makeFakeSelector(target, OWN_POLICY_SELECTOR)`
   *
   * @param target Address of the target contract. It must be one previously added with {addTarget}.
   * @param data The call to execute on the target contract
   */
  function forwardNewPolicy(
    address target,
    bytes calldata data
  ) external forwardNewPolicyWrapper(target) returns (bytes memory result) {
    _checkCanForward(_msgSender(), target, bytes4(data[0:4]));
    result = target.functionCall(data);
    uint256 policyId = abi.decode(result, (uint256));
    if (IERC721(address(_policyPool)).ownerOf(policyId) != address(this)) {
      // Check the caller is allowed to create policies not owned by the CFL
      _checkCanForward(_msgSender(), target, OWN_POLICY_SELECTOR);
    }
  }

  /**
   * @dev Forwards a call to the target contract, previously checking the target is active and tracking the increased
   *      debt (in the current time slot). Batch version (multiple calls at once).
   *
   *      When the `_balance()` is lower than `targetConfig.minLiquidity` it deinvests, but it doesn't fail if can't
   *      deinvest all the required funds. If the required premiums are higher than the available balance, then it
   *      will fail anyway.
   *
   *      If after the operation the debt is higher than targetConfig.debtLimit, it reverts.
   *
   *      Requires the _msgSender() has permission to call address(this) on the fakeSelector (see {makeFakeSelector})
   *
   *      Requires the return value of the called function returns the policyId and checks if the resulting policy
   *      (a PolicyPool NFT), is owned by the CFL.
   *      If it's not, it requires the _msgSender() has permission to call address(this) on
   *      `makeFakeSelector(target, OWN_POLICY_SELECTOR)`
   *
   * @param target Address of the target contract. It must be one previously added with {addTarget}.
   * @param data[] The calls to execute on the target contract
   */
  function forwardNewPolicyBatch(
    address target,
    bytes[] calldata data
  ) external forwardNewPolicyWrapper(target) returns (bytes[] memory result) {
    bytes4 lastSelector;
    bool ownOK = false;
    result = new bytes[](data.length);
    for (uint256 i; i < data.length; ++i) {
      bytes4 selector = bytes4(data[i][0:4]);
      if (i == 0 || selector != lastSelector) {
        // After the first one, only re-checks if the selector changed
        _checkCanForward(_msgSender(), target, selector);
        lastSelector = selector;
      }
      result[i] = target.functionCall(data[i]);
      if (!ownOK) {
        uint256 policyId = abi.decode(result[i], (uint256));
        if (IERC721(address(_policyPool)).ownerOf(policyId) != address(this)) {
          // Check the caller is allowed to create policies not owned by the CFL
          _checkCanForward(_msgSender(), target, OWN_POLICY_SELECTOR);
          ownOK = true;
        }
      }
    }
  }

  /**
   * @dev Forwards a call to the target contract, previously checking the target is active (or deprecated). It doesn't
   *      track the debt change explicitly, but this should change when policies are resolved and onPayoutReceived
   *      is called.
   *
   *      Requires the _msgSender() has permission to call address(this) on the fakeSelector (see {makeFakeSelector})
   *
   * @param target Address of the target contract. It must be one previously added with {addTarget}.
   * @param data The calls to execute on the target contract
   */
  function forwardResolvePolicy(
    address target,
    bytes calldata data
  ) external forwardResolvePolicyWrapper(target) returns (bytes memory result) {
    _checkCanForward(_msgSender(), target, bytes4(data[0:4]));
    result = target.functionCall(data);
  }

  /**
   * @dev Forwards a call to the target contract, previously checking the target is active (or deprecated). It doesn't
   *      track the debt change explicitly, but this should change when policies are resolved and onPayoutReceived
   *      is called. Batch version (multiple calls at once).
   *
   *      Requires the _msgSender() has permission to call address(this) on the fakeSelector (see {makeFakeSelector})
   *
   * @param target Address of the target contract. It must be one previously added with {addTarget}.
   * @param data[] The calls to execute on the target contract
   */
  function forwardResolvePolicyBatch(
    address target,
    bytes[] calldata data
  ) external forwardResolvePolicyWrapper(target) returns (bytes[] memory result) {
    bytes4 lastSelector;
    result = new bytes[](data.length);
    for (uint256 i; i < data.length; ++i) {
      bytes4 selector = bytes4(data[i][0:4]);
      if (i == 0 || selector != lastSelector) {
        // After the first one, only re-checks if the selector changed
        _checkCanForward(_msgSender(), target, selector);
        lastSelector = selector;
      }
      result[i] = target.functionCall(data[i]);
    }
  }

  function currentDebt() external view returns (int256) {
    CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
    return int256($._totalDebt);
  }

  function getDebtForPeriod(address target, uint32 slotSize, uint32 slotIndex) external view returns (int256) {
    CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
    return $._debtByPeriod[_makeTargetSlot(target, slotSize, slotIndex)];
  }

  /// @inheritdoc ERC4626Upgradeable
  function totalAssets() public view override returns (uint256 assets) {
    CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
    assets = _balance();
    assets += $._yieldVault.convertToAssets($._yieldVault.balanceOf(address(this)));
    if ($._totalDebt < 0) {
      assets -= uint256(-int256($._totalDebt));
    } else {
      assets += uint256(int256($._totalDebt));
    }
  }

  function cashWithdrawable() public view returns (uint256) {
    CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
    return _balance() + $._yieldVault.maxWithdraw(address(this));
  }

  /// @inheritdoc ERC4626Upgradeable
  function maxRedeem(address owner) public view virtual override returns (uint256) {
    return Math.min(super.maxRedeem(owner), convertToShares(cashWithdrawable()));
  }

  /// @inheritdoc ERC4626Upgradeable
  function maxWithdraw(address owner) public view virtual override returns (uint256) {
    return Math.min(super.maxWithdraw(owner), cashWithdrawable());
  }

  function _withdraw(
    address caller,
    address receiver,
    address owner,
    uint256 assets,
    uint256 shares
  ) internal virtual override {
    uint256 balance = _balance();
    if (balance < assets) {
      // If not enough money liquid in the contract, deinvests from the vault
      CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
      require((assets - balance) <= $._yieldVault.maxWithdraw(address(this)), NotEnoughCash());
      $._yieldVault.withdraw(assets - balance, address(this), address(this));
    }
    super._withdraw(caller, receiver, owner, assets, shares);
  }

  /**
   * @dev Deinvest from the vault a given amount.
   *
   *      Requires $._yieldVault.maxWithdraw() <= amount
   *
   * @param amount Amount to withdraw from the `$._yieldVault`. If equal type(uint256).max, deinvests maxWithdraw()
   */
  function withdrawFromYieldVault(uint256 amount) external {
    if (amount == type(uint256).max) {
      CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
      amount = $._yieldVault.maxWithdraw(address(this));
    }
    require(_deinvest(amount) == amount, NotEnoughCash());
  }

  /**
   * @dev Moves money that's liquid in the contract to the yield vault, to generate yields
   *
   *      Requires _balance() >= amount
   *
   * @param amount Amount to transfer to the `$._yieldVault`. If equal type(uint256).max, transfers `_balance()`
   */
  function depositIntoYieldVault(uint256 amount) external {
    if (amount == type(uint256).max) {
      amount = _balance();
    } else {
      require(amount <= _balance(), NotEnoughCash());
    }
    CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
    $._yieldVault.deposit(amount, address(this));
  }

  /**
   * @dev Extracts money from the CFL that's owed to the customer, adjusting the debt (from negative to less negative)
   *      in a given slot
   *
   *      Requires the debt of the slot <= -amount
   *      Requires the CFL has enough funds (liquid + invested in the $._yieldVault)
   *
   *      emits {CashOutPayout}
   *
   * @param target Address of the target contract. It must be one previously added with {addTarget}.
   * @param slotSize Duration in seconds of the slots used to track the debt. The debt uses UTC aligned slots.
   * @param slotIndex Current slot time selected
   * @param amount Amount to cash out
   * @param destination Address that will receive the funds
   */
  function cashOutPayouts(
    address target,
    uint32 slotSize,
    uint32 slotIndex,
    uint256 amount,
    address destination
  ) external {
    _getTargetConfig(target);
    // Modify the debt
    int256 debtAfter = _changeDebt(target, slotSize, slotIndex, amount.toInt256());
    require(debtAfter <= 0, CashOutExceedsLimit(amount, debtAfter));

    // Transfer the asset (deinvest if needed)
    uint256 balance = _balance();
    if (balance < amount) {
      require(_deinvest(amount - balance) == (amount - balance), NotEnoughCash());
    }
    IERC20Metadata(asset()).safeTransfer(destination, amount);
    emit CashOutPayout(target, slotSize, slotIndex, amount, debtAfter, destination);
  }

  /**
   * @dev Repays debt to the CFL that's owed by the customer, adjusting the debt (from positive to less positive)
   *      in a given slot
   *
   *      Requires the debt of the slot >= amount
   *
   *      emits {RepayDebt}
   *
   * @param target Address of the target contract. It must be one previously added with {addTarget}.
   * @param slotSize Duration in seconds of the slots used to track the debt. The debt uses UTC aligned slots.
   * @param slotIndex Current slot time selected
   * @param amount Amount to pay
   */
  function repayDebt(address target, uint32 slotSize, uint32 slotIndex, uint256 amount) external {
    _getTargetConfig(target);

    // Modify the debt
    int256 debtAfter = _changeDebt(target, slotSize, slotIndex, -amount.toInt256());
    require(debtAfter >= 0, RepaymentExceedsLimit(amount, debtAfter));

    IERC20Metadata(asset()).safeTransferFrom(_msgSender(), address(this), amount);
    emit RepayDebt(target, slotSize, slotIndex, amount, debtAfter, _msgSender());
  }
}
