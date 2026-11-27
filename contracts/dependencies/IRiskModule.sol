// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {Policy} from "@ensuro/core/contracts/Policy.sol";

/**
 * @dev Minimalistic version of the IRiskModule interface, just the methods needed for this project
 */
interface IRiskModule {
  /**
   * @dev Creates a new policy. The premium will paid by msg.sender
   *
   * @param inputData Input data that will be decoded by the _underwriter to construct the parameters for the
   *                  new policy.
   * @param onBehalfOf The address that will be the owner of the created policy
   */
  function newPolicy(bytes calldata inputData, address onBehalfOf) external returns (Policy.PolicyData memory policy);

  /**
   * @dev Creates several policies, the premium is paid by msg.sender
   *
   * @param inputData Input data that will be decoded by the _underwriter to construct the parameters for the
   *                  new policy.
   * @param onBehalfOf The address that will be the owner of the created policy (same for all the policies)
   */
  function newPolicies(bytes[] calldata inputData, address onBehalfOf) external;

  /**
   * @dev Replaces a policy with a new one, with the same owner
   *
   * @param inputData Input data that will be decoded by the _underwriter to construct the oldPolicy and the
   *                  parameters for the new policy.
   */
  function replacePolicy(bytes calldata inputData) external returns (Policy.PolicyData memory policy);

  /**
   * @dev Cancels a policy, giving back all (or part) of the pure premium and the non-accrued CoC
   *
   * @param inputData Input data that will be decoded by the _underwriter to construct the oldPolicy and the
   *                  parameters for the new policy.
   */
  function cancelPolicy(bytes calldata inputData) external;

  /**
   * @dev Resolves a policy, if payout > 0, it pays to the policy holder.
   *
   * @param policy The policy previously created (from {NewPolicy} event)
   * @param payout The payout to transfer to the policy holder
   */
  function resolvePolicy(Policy.PolicyData calldata policy, uint256 payout) external;
}
