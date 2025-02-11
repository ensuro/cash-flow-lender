// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.16;

import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {ERC2771ContextUpgradeable} from "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";
import {ContextUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
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
import {IPolicyHolder} from "@ensuro/core/contracts/interfaces/IPolicyHolder.sol";
import {IPolicyHolderV2} from "@ensuro/core/contracts/interfaces/IPolicyHolderV2.sol";
import {AccessManagedProxy} from "./dependencies/AccessManagedProxy.sol";

/**
 * @title CashFlow Lender Module that tracks ownership
 * @dev Implements the ERC-4626 standard tracking how much liquidity was provided by each LP.
 *      The assets managed by the vault are a mix of liquid USDC + the _debt tracked by the CFL. The _debt can be
 *      negative, in that case, the CFL owes to the customer.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract CashFlowLender is ERC2771ContextUpgradeable, UUPSUpgradeable, ERC4626Upgradeable, IPolicyHolderV2, ERC165 {
  using SafeERC20 for IERC20Metadata;
  using SafeCast for uint256;
  using SafeCast for int256;
  using Address for address;

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IPolicyPool internal immutable _policyPool;

  type TargetSlot is bytes32; // (target_address, slotSize, block.timestamp / slotSize) packed as bytes32

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
  bytes32 private constant CashFlowLenderStorageLocation =
    0x0dff660c705ec490383ffafc9e8e3ab4714559f9ec8567c5380d4ad2dff5af00;

  function _getCashFlowLenderStorage() private pure returns (CashFlowLenderStorage storage $) {
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
  error UnauthorizedForward(address caller, address target, bytes4 selector);
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
    uint256 balanceBefore = _balance();

    if (balanceBefore < uint256(targetConfig.minLiquidity)) {
      _deinvest(uint256(targetConfig.minLiquidity) - balanceBefore);
      balanceBefore = _balance();
    }
    _;
    uint256 balanceAfter = _balance();

    if (balanceAfter < balanceBefore) {
      // Should always increase the debt, but just in case...
      int256 currDebt = _changeDebt(
        target,
        targetConfig.slotSize,
        (block.timestamp / targetConfig.slotSize).toUint32(),
        (balanceBefore - balanceAfter).toInt256()
      );
      require(currDebt <= int256(uint256(targetConfig.debtLimit)), DebtLimitExceeded(currDebt, targetConfig.debtLimit));
    }
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

    require(balanceAfter >= balanceBefore, BalanceDecreasedOnResolve(balanceBefore - balanceAfter));
  }

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(address trustedForwarder_, IPolicyPool policyPool_) ERC2771ContextUpgradeable(trustedForwarder_) {
    _policyPool = policyPool_;
    _disableInitializers();
  }

  /**
   * @dev Initializes the MultiTargetCFL
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
    __UUPSUpgradeable_init();
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

    CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
    IERC4626 oldVault = $._yieldVault;
    $._yieldVault = yieldVault_;
    if (address(oldVault) != address(0)) IERC20Metadata(asset()).approve(address(oldVault), 0);
    IERC20Metadata(asset()).approve(address(yieldVault_), type(uint256).max);
    emit YieldVaultChanged(oldVault, yieldVault_);
  }

  function _getTargetConfig(address target) internal returns (TargetConfig storage targetConfig) {
    CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
    targetConfig = $._targets[target];
    require(targetConfig.status != TargetStatus.inactive, TargetNotFound(target));
  }

  function setYieldVault(IERC4626 yieldVault_, bool force) external {
    CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
    uint256 yieldAssets = $._yieldVault.convertToAssets($._yieldVault.balanceOf(address(this)));
    require(_deinvest(yieldAssets) == yieldAssets || force, CannotDeinvestYieldVault());
    _setYieldVault(yieldVault_);
  }

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

  function changeTargetLimits(address target, uint256 debtLimit, uint256 minLiquidity) external {
    TargetConfig storage targetConfig = _getTargetConfig(target);
    emit TargetLimitsChanged(target, targetConfig.debtLimit, debtLimit, targetConfig.minLiquidity, minLiquidity);
    targetConfig.debtLimit = debtLimit.toUint96();
    targetConfig.minLiquidity = minLiquidity.toUint96();
  }

  function changeTargetStatus(address target, TargetStatus newStatus) external {
    // Check the newStatus != inactive. If you want to disable a target, move it to suspended
    require(newStatus != TargetStatus.inactive, CannotDeactivateTarget());
    TargetConfig storage targetConfig = _getTargetConfig(target);
    emit TargetStatusChanged(target, targetConfig.status, newStatus);
    targetConfig.status = newStatus;
  }

  function changeTargetSlotSize(address target, uint32 newSlotSize) external {
    require(newSlotSize != 0, InvalidSlotSize());
    TargetConfig storage targetConfig = _getTargetConfig(target);
    emit TargetSlotSizeChanged(target, targetConfig.slotSize, newSlotSize);
    targetConfig.slotSize = newSlotSize;
  }

  /**
   * @dev See {IERC165-supportsInterface}.
   */
  function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
    return
      interfaceId == type(IPolicyHolder).interfaceId ||
      interfaceId == type(IPolicyHolderV2).interfaceId ||
      super.supportsInterface(interfaceId);
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address newImpl) internal view override {}

  function onERC721Received(
    address,
    address,
    uint256,
    bytes calldata
  ) external view override onlyPolicyPool returns (bytes4) {
    return IERC721Receiver.onERC721Received.selector;
  }

  function onPolicyExpired(address, address, uint256) external view override onlyPolicyPool returns (bytes4) {
    return IPolicyHolder.onPolicyExpired.selector;
  }

  function onPayoutReceived(
    address operator,
    address,
    uint256,
    uint256 amount
  ) external override onlyPolicyPool returns (bytes4) {
    CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
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
      (block.timestamp / targetConfig.slotSize).toUint32(),
      -amount.toInt256()
    );
    return IPolicyHolder.onPayoutReceived.selector;
  }

  function onPolicyReplaced(address, address, uint256, uint256) external override onlyPolicyPool returns (bytes4) {
    return IPolicyHolderV2.onPolicyReplaced.selector;
  }

  // Fix Context base contract duplicates
  function _contextSuffixLength()
    internal
    view
    override(ContextUpgradeable, ERC2771ContextUpgradeable)
    returns (uint256)
  {
    return ERC2771ContextUpgradeable._contextSuffixLength();
  }

  function _msgSender() internal view override(ContextUpgradeable, ERC2771ContextUpgradeable) returns (address) {
    return ERC2771ContextUpgradeable._msgSender();
  }

  function _msgData() internal view override(ContextUpgradeable, ERC2771ContextUpgradeable) returns (bytes calldata) {
    return ERC2771ContextUpgradeable._msgData();
  }

  function _balance() internal view returns (uint256) {
    return IERC20Metadata(asset()).balanceOf(address(this));
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

  function makeFakeSelector(address target, bytes4 selector) public pure returns (bytes4) {
    return Packing.extract_32_4(keccak256(abi.encodePacked(target, selector)), 0);
  }

  function _checkCanForward(address caller, address target, bytes4 selector) internal {
    bytes4 fakeSelector = makeFakeSelector(target, selector);
    (bool immediate, ) = AccessManagedProxy(payable(address(this))).ACCESS_MANAGER().canCall(
      caller,
      address(this),
      fakeSelector
    );
    require(immediate, UnauthorizedForward(caller, target, selector));
  }

  function forwardNewPolicy(
    address target,
    bytes calldata data
  ) external forwardNewPolicyWrapper(target) returns (bytes memory result) {
    _checkCanForward(_msgSender(), target, bytes4(data[0:4]));
    result = target.functionCall(data);
  }

  function forwardNewPolicyBatch(
    address target,
    bytes[] calldata data
  ) external forwardNewPolicyWrapper(target) returns (bytes[] memory result) {
    bytes4 lastSelector;
    for (uint256 i; i < data.length; i++) {
      bytes4 selector = bytes4(data[i][0:4]);
      if (i == 0 || selector != lastSelector) {
        // After the first one, only re-checks if the selector changed
        _checkCanForward(_msgSender(), target, selector);
        lastSelector = selector;
      }
      result[i] = target.functionCall(data[i]);
    }
  }

  function forwardResolvePolicy(
    address target,
    bytes calldata data
  ) external forwardResolvePolicyWrapper(target) returns (bytes memory result) {
    _checkCanForward(_msgSender(), target, bytes4(data[0:4]));
    result = target.functionCall(data);
  }

  function forwardResolvePolicyBatch(
    address target,
    bytes[] calldata data
  ) external forwardResolvePolicyWrapper(target) returns (bytes[] memory result) {
    bytes4 lastSelector;
    for (uint256 i; i < data.length; i++) {
      bytes4 selector = bytes4(data[i][0:4]);
      if (i == 0 || selector != lastSelector) {
        // After the first one, only re-checks if the selector changed
        _checkCanForward(_msgSender(), target, selector);
        lastSelector = selector;
      }
      result[i] = target.functionCall(data[i]);
    }
  }

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

  function currentDebt() external view returns (int256) {
    CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
    return int256($._totalDebt);
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
      CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
      require((assets - balance) < $._yieldVault.maxWithdraw(address(this)), NotEnoughCash());
      $._yieldVault.withdraw(assets - balance, address(this), address(this));
    }
    super._withdraw(caller, receiver, owner, assets, shares);
  }

  function withdrawFromYieldVault(uint256 amount) external {
    if (amount == type(uint256).max) {
      CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
      amount = $._yieldVault.maxWithdraw(address(this));
    }
    require(_deinvest(amount) == amount, NotEnoughCash());
  }

  function depositIntoYieldVault(uint256 amount) external {
    if (amount == type(uint256).max) {
      amount = _balance();
    } else {
      require(amount <= _balance(), NotEnoughCash());
    }
    CashFlowLenderStorage storage $ = _getCashFlowLenderStorage();
    $._yieldVault.deposit(amount, address(this));
  }

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

  function repayDebt(address target, uint32 slotSize, uint32 slotIndex, uint256 amount) external {
    _getTargetConfig(target);

    // Modify the debt
    int256 debtAfter = _changeDebt(target, slotSize, slotIndex, -amount.toInt256());
    require(debtAfter >= 0, RepaymentExceedsLimit(amount, debtAfter));

    IERC20Metadata(asset()).safeTransferFrom(_msgSender(), address(this), amount);
    emit RepayDebt(target, slotSize, slotIndex, amount, debtAfter, _msgSender());
  }
}
