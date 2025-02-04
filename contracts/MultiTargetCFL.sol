// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.16;

import {IPolicyHolder} from "@ensuro/core/contracts/interfaces/IPolicyHolder.sol";
import {IPolicyHolderV2} from "@ensuro/core/contracts/interfaces/IPolicyHolderV2.sol";

import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IPolicyPool} from "./dependencies/IPolicyPool.sol";

/**
 * @title CashFlow Lender Module that tracks ownership
 * @dev Implements the ERC-4626 standard tracking how much liquidity was provided by each LP.
 *      The assets managed by the vault are a mix of liquid USDC + the _debt tracked by the CFL. The _debt can be
 *      negative, in that case, the CFL owes to the customer.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract MultiTargetCFL is UUPSUpgradeable, ERC4626Upgradeable, IPolicyHolderV2, ERC165 {
  using SafeERC20 for IERC20Metadata;

  IPolicyPool internal _policyPool;
  int256 internal _debt;

  error InvalidPolicyPool();

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  /**
   * @dev Initializes the MultiTargetCFL
   */
  function initialize(string memory name_, string memory symbol_, IPolicyPool policyPool_) public virtual initializer {
    __MultiTargetCFL_init(name_, symbol_, policyPool_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __MultiTargetCFL_init(
    string memory name_,
    string memory symbol_,
    IPolicyPool policyPool_
  ) internal onlyInitializing {
    __UUPSUpgradeable_init();
    require(address(policyPool_) != address(0), InvalidPolicyPool());
    address asset_ = address(policyPool_.currency());
    require(asset_ != address(0), InvalidPolicyPool());
    __ERC4626_init(IERC20(asset_));
    __ERC20_init(name_, symbol_);
    __MultiTargetCFL_init_unchained(policyPool_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __MultiTargetCFL_init_unchained(IPolicyPool policyPool_) internal onlyInitializing {
    _policyPool = policyPool_;
    // Infinite approval to the PolicyPool to pay the premiums
    policyPool_.currency().approve(address(policyPool_), type(uint256).max);
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

  function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
    return IERC721Receiver.onERC721Received.selector;
  }

  function onPolicyExpired(address, address, uint256) external pure override returns (bytes4) {
    return IPolicyHolder.onPolicyExpired.selector;
  }

  function onPayoutReceived(address, address, uint256, uint256 amount) external override returns (bytes4) {
    // require(msg.sender == address(_pool()), "Only the PolicyPool should call this method");
    // _decreaseDebt(amount);
    return IPolicyHolder.onPayoutReceived.selector;
  }

  function onPolicyReplaced(address, address, uint256, uint256) external override returns (bytes4) {
    return IPolicyHolderV2.onPolicyReplaced.selector;
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[48] private __gap;
}
