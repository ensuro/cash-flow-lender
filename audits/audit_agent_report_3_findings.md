# Audit Agent Report #3 — Findings Response

This document records our stance on the findings in
[`audit_agent_report_3_27869303-2b9b-49c2-a232-e59eecc12d2b.pdf`](./audit_agent_report_3_27869303-2b9b-49c2-a232-e59eecc12d2b.pdf).

Report: Nethermind AuditAgent scan #3 (September 18, 2026), commit `58c1d1d5…b4f5dd7d`.
Findings: 2 High, 6 Medium, 3 Low.

## Finding #1 — Acknowledged (High)

_LP withdrawals can consume cash that is earmarked for policyholder payouts because `cashWithdrawable()` ignores
negative debt._

This is an accepted consequence of tracking debt globally and netting positive and negative debt across targets and
periods. Positive debt is a receivable from a partner, while negative debt is a liability to a policyholder.
`cashWithdrawable()` intentionally limits LP exits by liquid funds rather than by the signed debt, so an LP can
withdraw cash that is economically matched by another partner's receivable. Partners are trusted counterparties and
are expected to repay their debt. If a partner defaults, the shortfall is borne by the remaining LPs (see Finding #8).
We acknowledge this risk and do not add per-target isolation in this version.

## Finding #2 — Acknowledged (High)

_Policy-holder reentrant deposits can mask premium outflows in new-policy debt accounting._

Exploiting this requires a malicious policyholder and an actor with permission to call the vault's deposit/mint path
coordinating during `onERC721Received`. No mutable method of the CFL is intended to be open to untrusted actors: all
state-changing entry points are gated through the `AccessManagedProxy`, and deposits/mints as well as the `forward*`
methods are only granted to trusted operators. We accept this risk and do not add reentrancy guards; reentrancy
protection is not part of the CFL trust model.

## Finding #3 — Acknowledged (Medium)

_Proxy-level authorization of the trusted forwarder collapses ERC-2771 signer permissions for privileged functions._

The trusted forwarder must only be granted the `forward*` selectors at the `AccessManagedProxy`/`AccessManager`
level. Privileged selectors (`cashOutPayouts`, configuration setters, upgrades and yield-vault management) must be
granted directly to EOAs or smart accounts, never to the trusted forwarder. With that deployment rule the forwarder
cannot be used to bypass signer-level permissions because privileged methods are not forwarded. This requirement is
documented in the README trust model and in the `CashFlowLender` contract comments.

## Finding #4 — Fixed (Medium)

_Policy-creation calls can be routed through `forwardResolvePolicy`, bypassing debt accounting, `debtLimit`,
`minLiquidity` and the `OWN_POLICY_SELECTOR` check._

`forwardNewPolicy` and `forwardNewPolicyBatch` now only accept `newPolicy` and `replacePolicy`, while
`forwardResolvePolicy` and `forwardResolvePolicyBatch` only accept `resolvePolicy` and `cancelPolicy`. Any other
selector reverts with the `InvalidForwardMethod` custom error, so policies can no longer be created through the
resolve path.

## Finding #5 — Fixed (Medium)

_Yield-vault deposits lack a minimum-share check and can donate all liquid CFL assets through ERC-4626 rounding._

`depositIntoYieldVault` now checks the number of shares returned by the yield vault and reverts with
`YieldVaultDepositReturnedNoShares` when a non-zero deposit mints zero shares. Zero-amount deposits are handled as a
no-op without calling the yield vault.

## Finding #6 — Pending (Medium)

_Forced yield-vault migration abandons residual old-vault shares from accounting._

Planned fix in a follow-up commit on this branch.

## Finding #7 — Fixed (Medium)

_Cash-out authorization is not scoped to the target or payout destination._

`cashOutPayouts` no longer accepts a caller-supplied destination. Each target has a configured destination, with a
contract-wide default fallback, and the call reverts with `CashOutDestinationNotConfigured` when neither is set.
Added `setCashOutDestination`, `setDefaultCashOutDestination`, `getCashOutDestination` and
`defaultCashOutDestination`.

## Finding #8 — Acknowledged (Medium)

_No mechanism to write down uncollectible positive debt, keeping the share price permanently inflated._

There is no on-chain write-off mechanism by design. In our operating context positive debt is expected to be
collected; if a partner defaults, the debt can be repaid directly with `repayDebt` (or settled operationally). We
accept the risk of valuing outstanding receivables at face value.

## Finding #9 — Fixed (Low)

_Batch V3 policy creation is authorized using the single-policy selector._

`forwardNewPoliciesV3` now authorizes against `IRiskModule.newPolicies.selector` instead of
`IRiskModule.newPolicy.selector`.

## Finding #10 — Acknowledged (Low)

_Changing a target's `slotSize` starts a fresh debt-limit bucket while prior debt remains outstanding._

Changing a target's slot size is a privileged configuration action and must only be performed after the outstanding
debt for the target has been settled. If it is changed earlier, the previous debt remains readable and settleable
using its original `(target, slotSize, slotIndex)` tuple, so accounting is fragmented across buckets by design. We
accept this behavior and rely on the operational rule above.

## Finding #11 — Fixed (Low)

_`_deinvest` issues a zero-amount yield-vault withdrawal, which can block policy origination with some ERC-4626
vaults._

`_deinvest` now skips the `withdraw` call when the computed amount is zero.
