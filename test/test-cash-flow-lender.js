const { expect } = require("chai");
const {
  amountFunction,
  tagit,
  makeAllViewsPublic,
  setupAMSuperAdminRole,
  setupAMRole,
  getRole,
  _W,
  getAddress,
  captureAny,
} = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { DAY } = require("@ensuro/utils/js/constants");
const { deployPool, deployPremiumsAccount, addRiskModule, addEToken } = require("../js/binary-ensuro-test-utils");

const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { deploy: ozUpgradesDeploy } = require("@openzeppelin/hardhat-upgrades/dist/utils");

const { ethers } = hre;
const { ZeroAddress, MaxUint256 } = ethers;

const CURRENCY_DECIMALS = 6;
const _A = amountFunction(CURRENCY_DECIMALS);
const INITIAL = 10000;
const NAME = "Cash Flow Lender";
const SYMB = "CFL";

async function setUp() {
  const [, lp, lp2, anon, admin, cflAdmin, bridge23] = await ethers.getSigners();
  const currency = await initCurrency(
    { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(50000), extraArgs: [admin] },
    [lp, lp2],
    [_A(INITIAL), _A(INITIAL)]
  );

  const adminAddr = await ethers.resolveAddress(admin);
  const AccessManagedProxy = await ethers.getContractFactory("AccessManagedProxy");
  const AccessManager = await ethers.getContractFactory("AccessManager");
  const acMgr = await AccessManager.deploy(admin);

  const pool = await deployPool({
    currency: currency,
    grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
    treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", // Random address
  });
  pool._A = _A;

  const ensAccMgr = await ethers.getContractAt("@ensuro/core/AccessManager", await pool.access());
  // Setup the liquidity sources
  const etk = await addEToken(pool, {});
  const premiumsAccount = await deployPremiumsAccount(pool, { srEtk: etk });

  // Provide some liquidity
  await currency.connect(lp).approve(pool, _A(5000));
  await pool.connect(lp).deposit(etk, _A(5000));

  const TestERC4626 = await ethers.getContractFactory("TestERC4626");
  const CashFlowLender = await ethers.getContractFactory("CashFlowLender");
  const yieldVault = await TestERC4626.deploy("Yield Vault", "YIELD", currency);

  return {
    currency,
    adminAddr,
    lp,
    lp2,
    anon,
    admin,
    cflAdmin,
    bridge23,
    AccessManagedProxy,
    AccessManager,
    acMgr,
    CashFlowLender,
    TestERC4626,
    yieldVault,
    pool,
    etk,
    premiumsAccount,
    ensAccMgr,
  };
}

let uniqueInternalId = 1000; // Variable to generate consecutive internalIds

const variants = [
  {
    name: "NoTrustedForwarder+Trustful",
    tagit: tagit,
    fixture: async () => {
      const ret = await setUp();
      const {
        admin,
        CashFlowLender,
        yieldVault,
        acMgr,
        pool,
        AccessManagedProxy,
        premiumsAccount,
        ensAccMgr,
        lp,
        lp2,
        cflAdmin,
        bridge23,
      } = ret;

      // Create and add the RiskModule
      const RiskModule = await ethers.getContractFactory("@ensuro/core/TrustfulRiskModule");
      const rm = await addRiskModule(pool, premiumsAccount, RiskModule, {
        ensuroFee: 0.03,
      });

      // Create and setup the CFL
      const cfl = await hre.upgrades.deployProxy(
        CashFlowLender,
        [NAME, SYMB, await ethers.resolveAddress(yieldVault)],
        {
          kind: "uups",
          unsafeAllow: [
            "delegatecall",
            "missing-initializer-call", // This is to fix an error because it says we are not calling
            // parent initializer
          ],
          proxyFactory: AccessManagedProxy,
          constructorArgs: [ZeroAddress, await ethers.resolveAddress(pool)],
          deployFunction: async (hre_, opts, factory, ...args) => ozUpgradesDeploy(hre_, opts, factory, ...args, acMgr),
        }
      );
      await makeAllViewsPublic(acMgr.connect(admin), cfl);

      const ADMIN_ROLE = await setupAMSuperAdminRole(acMgr.connect(admin), cfl);
      await acMgr.connect(admin).grantRole(ADMIN_ROLE, cflAdmin, 0);

      const roles = {
        LP_ROLE: 1,
        SMART_ACCOUNT: 2, // Calls to forward... methods, used in operations
        USER_OP_SIGNER: 3, // Permissions that will be granted to the userOp signer (_msgSender() when using 2771)
      };
      await setupAMRole(acMgr.connect(admin), cfl, roles, "LP_ROLE", [
        "withdraw",
        "deposit",
        "mint",
        "redeem",
        "transfer",
      ]);
      await acMgr.connect(admin).grantRole(roles.LP_ROLE, lp, 0);
      await acMgr.connect(admin).grantRole(roles.LP_ROLE, lp2, 0);

      await setupAMRole(acMgr.connect(admin), cfl, roles, "SMART_ACCOUNT", [
        "forwardNewPolicy",
        "forwardNewPolicyBatch",
        "forwardResolvePolicy",
        "forwardResolvePolicyBatch",
      ]);
      await acMgr.connect(admin).grantRole(roles.SMART_ACCOUNT, bridge23, 0);

      // Grant Permissions to the CFL
      await ensAccMgr.grantComponentRole(rm, getRole("PRICER_ROLE"), cfl);
      await ensAccMgr.grantComponentRole(rm, getRole("REPLACER_ROLE"), cfl);
      await ensAccMgr.grantComponentRole(rm, getRole("RESOLVER_ROLE"), cfl);

      return {
        ADMIN_ROLE,
        smartAccount: bridge23, // The bridge23 and the smart account are the same in this variant
        cfl,
        trustedForwarder: ZeroAddress,
        rm,
        roles,
        ...ret,
      };
    },

    createPolicyCall: async ({ rm, cfl }, policyParams, onBehalfOf = undefined) => {
      // returns the call, selector, and premium amount
      const premium = policyParams.premium || MaxUint256;
      const payout = policyParams.payout || _A(100);
      const lossProb = policyParams.lossProb || _W("0.05");
      const expiration = policyParams.expiration || (await helpers.time.latest()) + 30 * DAY;
      // eslint-disable-next-line no-plusplus
      const internalId = policyParams.internalId || ++uniqueInternalId;
      const chargedPremium =
        premium === MaxUint256 ? await rm.getMinimumPremium(payout, lossProb, expiration) : premium;
      const newPolicyCall = rm.interface.encodeFunctionData("newPolicy", [
        payout,
        premium,
        lossProb,
        expiration,
        getAddress(onBehalfOf || cfl),
        internalId,
      ]);
      return { newPolicyCall, chargedPremium, selector: rm.interface.getFunction("newPolicy").selector };
    },

    callForwardMethod: async (ret, method, target, methodCall) =>
      ret.cfl.connect(ret.smartAccount)[method](target, methodCall),
  },
];

variants.forEach((variant) => {
  describe(`CashFlowLender contract tests - Variant:${variant.name}`, function () {
    variant.tagit("Checks vault constructs with disabled initializer ", async () => {
      const { CashFlowLender, pool, yieldVault } = await helpers.loadFixture(variant.fixture);
      const newCFL = await CashFlowLender.deploy(ZeroAddress, pool);
      await expect(newCFL.deploymentTransaction()).to.emit(newCFL, "Initialized");
      await expect(newCFL.initialize(NAME, SYMB, yieldVault)).to.be.revertedWithCustomError(
        CashFlowLender,
        "InvalidInitialization"
      );
    });

    variant.tagit("Initializes with the right values", async () => {
      const { cfl, pool, yieldVault, currency, acMgr, trustedForwarder, AccessManagedProxy } =
        await helpers.loadFixture(variant.fixture);

      expect(await cfl.asset()).to.equal(currency);
      expect(await cfl.policyPool()).to.equal(pool);
      expect(await cfl.yieldVault()).to.equal(yieldVault);
      expect(await cfl.totalAssets()).to.equal(0);
      expect(await cfl.name()).to.equal(NAME);
      expect(await cfl.symbol()).to.equal(SYMB);
      expect(await cfl.trustedForwarder()).to.equal(trustedForwarder);
      expect(await AccessManagedProxy.attach(cfl).ACCESS_MANAGER()).to.equal(acMgr);

      // Max allowance granted to both the policyPool and yieldVault
      expect(await currency.allowance(cfl, pool)).to.equal(MaxUint256);
      expect(await currency.allowance(cfl, yieldVault)).to.equal(MaxUint256);
    });

    variant.tagit("Can forward a new policy", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool, bridge23, acMgr, roles, admin } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));

      const { newPolicyCall, chargedPremium, selector } = await variant.createPolicyCall(ret, {});

      const newPolicyFakeSelector = await cfl.makeFakeSelector(rm, selector);

      // Fails because of the missing permission
      await expect(variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall))
        .to.be.revertedWithCustomError(cfl, "UnauthorizedForward")
        .withArgs(bridge23, rm, newPolicyFakeSelector);

      await setupAMRole(acMgr.connect(admin), cfl, roles, "USER_OP_SIGNER", [newPolicyFakeSelector]);
      await acMgr.connect(admin).grantRole(roles.USER_OP_SIGNER, bridge23, 0);

      await expect(variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall))
        .to.be.revertedWithCustomError(cfl, "ERC20InsufficientBalance")
        .withArgs(cfl, 0, captureAny.uint);

      // The amount that fails is the purePremium, not the chargedPremium - So I accept 10% difference
      expect(captureAny.lastUint).to.closeTo(chargedPremium, _A(0.1) * chargedPremium);

      // Deposit some funds in the CFL
      await currency.connect(lp2).approve(cfl, _A(100));
      await cfl.connect(lp2).deposit(_A(100), lp2);

      await expect(variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall))
        .to.emit(pool, "NewPolicy")
        .withArgs(rm, captureAny.value);
      const newPolicy = captureAny.lastValue;
      expect(newPolicy.premium).to.closeTo(chargedPremium, _A("0.0001"));

      expect(await pool.ownerOf(newPolicy.id)).to.equal(cfl);
    });

    variant.tagit("Can forward a new policy owned by someone else", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool, bridge23, acMgr, roles, admin, anon } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));

      const { newPolicyCall, chargedPremium, selector } = await variant.createPolicyCall(ret, {}, anon);

      const newPolicyFakeSelector = await cfl.makeFakeSelector(rm, selector);
      const ownedPolicyFakeSelector = await cfl.makeFakeSelector(rm, await cfl.OWN_POLICY_SELECTOR());

      await setupAMRole(acMgr.connect(admin), cfl, roles, "USER_OP_SIGNER", [newPolicyFakeSelector]);
      await acMgr.connect(admin).grantRole(roles.USER_OP_SIGNER, bridge23, 0);

      // Deposit some funds in the CFL
      await currency.connect(lp2).approve(cfl, _A(100));
      await cfl.connect(lp2).deposit(_A(100), lp2);

      // Fails because of the missing permission
      await expect(variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall))
        .to.be.revertedWithCustomError(cfl, "UnauthorizedForward")
        .withArgs(bridge23, rm, ownedPolicyFakeSelector);

      await setupAMRole(acMgr.connect(admin), cfl, roles, "USER_OP_SIGNER", [ownedPolicyFakeSelector]);

      await expect(variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall))
        .to.emit(pool, "NewPolicy")
        .withArgs(rm, captureAny.value);
      const newPolicy = captureAny.lastValue;

      expect(newPolicy.premium).to.closeTo(chargedPremium, _A("0.0001"));

      expect(await pool.ownerOf(newPolicy.id)).to.equal(anon);
    });

    /**
     * Missing tests:
     *
     * 1. onXXX methods: check only policyPool can call them
     * 2. Vault related methods: changing the yield vault, rebalance, etc.
     * 3. Deposit and withdrawals and rebalance without debt
     * 4. Batch methods
     * 5. resolvePolicy methods.
     * 6. Calls to replacePolicy (should use also the same forwardNewPolicy methods)
     * 7. Calls to newPolicy with minLiquidity > 0 and 0 liquidity
     * 8. Calls to newPolicy with minLiquidity > 0 and some<minLiquidity
     * 9. Calls to newPolicy with minLiquidity > 0 and some<minLiquidity and (not) enough funds in the vault
     * 10. repayDebt / cashOutPayouts
     * 11. Target related methods
     * 12. Calendar month calculation tests (can be made making _computeCalendarMonth visible and then disabling)
     * 13. Current debt / totalAssets assertions
     */
  });
});
