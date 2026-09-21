# Cash Flow Lender

Smart contracts for the Cash Flow Lender (CFL), an [Ensuro](https://ensuro.co) module that lends liquidity to pay insurance premiums on behalf of partners. The CFL is an ERC-4626 vault: LPs deposit the protocol's stablecoin, the vault forwards policy creation and resolution calls to Ensuro risk modules (the _targets_), tracks the resulting debt per target and period, and invests idle funds in an ERC-4626 yield vault.

Positive debt is what the CFL has paid in premiums and partners must repay; negative debt is money received from policy payouts that's owed to policyholders. Partners repay with `repayDebt` and receive payouts with `cashOutPayouts`.

Built with [Hardhat 2](https://hardhat.org/) (JavaScript + Ethers) and Solidity `0.8.30` (`evmVersion: prague`).

## Contracts

### `CashFlowLender`

The vault and only contract of the system. It's UUPS-upgradeable and MUST be deployed behind an [AccessManagedProxy](https://github.com/ensuro/access-managed-proxy) — the contract itself doesn't perform access-control validations on the critical methods.

Policies are created and resolved by forwarding calls to the configured targets:

| Function                                                                      | Description                                                                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `forwardNewPolicy(address target, bytes data)`                                | Forwards `data` to `target` and increases the debt by the premium paid (balance reduction). Reverts if the period debt exceeds `debtLimit`. |
| `forwardNewPolicyBatch(address target, bytes[] data)`                         | Batched version of `forwardNewPolicy`.                                                                                                      |
| `forwardNewPolicyV3(address target, bytes inputData, address onBehalfOf)`     | Forwards `IRiskModule.newPolicy(inputData, onBehalfOf)`.                                                                                    |
| `forwardNewPoliciesV3(address target, bytes[] inputData, address onBehalfOf)` | Forwards `IRiskModule.newPolicies(inputData, onBehalfOf)`.                                                                                  |
| `forwardResolvePolicy(address target, bytes data)`                            | Forwards a resolution call; debt is adjusted through the `IPolicyHolder` callbacks. Reverts if the balance decreases.                       |
| `forwardResolvePolicyBatch(address target, bytes[] data)`                     | Batched version of `forwardResolvePolicy`.                                                                                                  |

Each target is configured with a slot size (`SLOTSIZE_CALENDAR_MONTH` for calendar months, or any duration in seconds), a debt limit per period and a minimum liquidity that's kept available before forwarding new policies:

| Function                                                                              | Description                                                    |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `addTarget(address target, uint32 slotSize, uint256 debtLimit, uint256 minLiquidity)` | Adds a target and sets its initial config.                     |
| `setTargetLimits(address target, uint256 debtLimit, uint256 minLiquidity)`            | Updates the debt limit and minimum liquidity.                  |
| `setTargetStatus(address target, TargetStatus newStatus)`                             | Sets `active`, `deprecated` (only resolutions) or `suspended`. |
| `setTargetSlotSize(address target, uint32 newSlotSize)`                               | Changes the period size.                                       |
| `getTargetStatus(address target)`                                                     | Returns the target's current status.                           |

Debt and liquidity:

| Function                                                                                                 | Description                                                                        |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `currentDebt()`                                                                                          | Global debt tracked by the CFL.                                                    |
| `getDebtForPeriod(address target, uint32 slotSize, uint32 slotIndex)`                                    | Debt for a given target and period.                                                |
| `cashOutPayouts(address target, uint32 slotSize, uint32 slotIndex, uint256 amount, address destination)` | Sends `amount` to `destination`, reducing a negative debt.                         |
| `repayDebt(address target, uint32 slotSize, uint32 slotIndex, uint256 amount)`                           | Pulls `amount` from the caller, reducing a positive debt.                          |
| `yieldVault()`                                                                                           | The ERC-4626 vault where idle funds are invested.                                  |
| `setYieldVault(IERC4626 newVault, bool force)`                                                           | Deinvests and switches to a new yield vault.                                       |
| `depositIntoYieldVault(uint256 amount)` / `withdrawFromYieldVault(uint256 amount)`                       | Moves funds in/out of the yield vault (`type(uint256).max` = all).                 |
| `cashWithdrawable()`                                                                                     | Liquid funds available immediately (balance + `maxWithdraw` from the yield vault). |

The ERC-4626 asset is taken from `policyPool.currency()` and `totalAssets()` is the sum of the liquid balance, the value of the yield vault position and the outstanding debt.

```solidity
constructor(address trustedForwarder_, IPolicyPool policyPool_)
```

```solidity
function initialize(string memory name_, string memory symbol_, IERC4626 yieldVault_) public initializer
```

#### Access control

Access control is enforced in two layers — once by the forward method and once by the target:

- **By method (proxy layer):** the `AccessManagedProxy` validates every call against the `AccessManager` by selector, using the real `msg.sender` (the trusted forwarder or a plain EOA).
- **By target (`_checkCanForward`):** every `forward*` method uses `_msgSender()` (ERC-2771). When invoked through the trusted forwarder, `_msgSender()` recovers the sender from the address in the last 20 bytes of the calldata — the caller injected by the trusted forwarder, not the forwarder itself. That injected sender is passed to the internal `_checkCanForward(caller, target, selector)`, which checks it against the `AccessManager` on a "fake selector" computed with `makeFakeSelector(target, selector)` that encodes the target.

Every allowed `(target, selector)` pair has a fake selector granted to the operator roles. Creating policies not owned by the CFL additionally requires permission on `makeFakeSelector(target, OWN_POLICY_SELECTOR)`.

#### `IPolicyHolder` callbacks

When policies owned by the CFL receive a payout or are cancelled, the PolicyPool calls `onPayoutReceived` / `onPolicyCancelled`, which reduce the debt of the current slot. `onPolicyExpired` and `onPolicyReplaced` are accepted without changing the debt.

### Interfaces

- `IPolicyHolder` — Ensuro policy-holder callbacks implemented by the CFL (`onPayoutReceived`, `onPolicyCancelled`, `onPolicyExpired`, `onPolicyReplaced`).
- `IPolicyPool` — minimal subset of Ensuro's PolicyPool used by the CFL (`currency()`).
- `IRiskModule` — minimal subset of Ensuro's RiskModule used to forward `newPolicy` / `newPolicies`.

## Prerequisites

- Node.js `24` (see `.nvmrc`); `nvm use`
- npm

## Setup

```bash
npm ci
```

## Commands

| Command                            | Description                      |
| ---------------------------------- | -------------------------------- |
| `npx hardhat compile`              | Compile contracts                |
| `npx hardhat test`                 | Run unit tests                   |
| `REPORT_GAS=true npx hardhat test` | Run tests with a gas report      |
| `npx hardhat coverage`             | Run tests with coverage          |
| `npx hardhat size-contracts`       | Print contract sizes             |
| `npm run solhint`                  | Lint Solidity                    |
| `npm run prettier`                 | Format Solidity/JS with Prettier |

## Tests

Unit tests run on the default in-memory network against the real `@ensuro/core` contracts and an `AccessManagedProxy`:

```bash
npx hardhat test
```

- `test/test-cash-flow-lender.js` — integration tests (trusted forwarder / smart account variants, target lifecycle, debt tracking, yield vault, cash out and repay, ...)
- `test/test-cfl-exposed.js` — internal/pure functions via `hardhat-exposed`
- `test/test-supports-interface.js` — ERC-165 interface support

## Deployment

Deploy the implementation with the trusted forwarder (`address(0)` if unused) and the Ensuro PolicyPool, then deploy the `AccessManagedProxy` and initialize it with the LP token name/symbol and the yield vault. The `@ensuro/access-managed-proxy` package provides the deployment utilities (`deployAMPProxy`) used by the tests. After deployment, add the targets with `addTarget` and grant the corresponding fake selectors through the `AccessManager`.

## NPM Package

The contracts and build artifacts are published as [`@ensuro/cash-flow-lender`](https://www.npmjs.com/package/@ensuro/cash-flow-lender). `scripts/make-npm-package.sh <version>` builds the package, and the `NPM Package` workflow publishes it automatically on `v*` tags (or manually via `workflow_dispatch`).
