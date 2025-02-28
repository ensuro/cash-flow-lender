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
const { packAccountGasLimits } = require("@ensuro/account-abstraction/js/userOp.js");

const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { deploy: ozUpgradesDeploy } = require("@openzeppelin/hardhat-upgrades/dist/utils");
const { anyValue, anyUint } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

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
    expectCustomError: async (_, operation, contract, errorName, errorArgs) =>
      expect(operation)
        .to.be.revertedWithCustomError(contract, errorName)
        .withArgs(...errorArgs),
    usesAA: false,
  },
  {
    name: "SmartAccountForwarder+Trustful",
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

      const EntryPoint = await ethers.getContractFactory("EntryPoint");
      const ep = await EntryPoint.deploy();
      const ERC2771ForwarderAccount = await ethers.getContractFactory("ERC2771ForwarderAccount");
      const smartAccount = await ERC2771ForwarderAccount.deploy(ep, admin, [bridge23]);

      await ep.depositTo(smartAccount, { value: _W(1) });

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
          constructorArgs: [await ethers.resolveAddress(smartAccount), await ethers.resolveAddress(pool)],
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
      await acMgr.connect(admin).grantRole(roles.SMART_ACCOUNT, smartAccount, 0);

      // Grant Permissions to the CFL
      await ensAccMgr.grantComponentRole(rm, getRole("PRICER_ROLE"), cfl);
      await ensAccMgr.grantComponentRole(rm, getRole("REPLACER_ROLE"), cfl);
      await ensAccMgr.grantComponentRole(rm, getRole("RESOLVER_ROLE"), cfl);

      return {
        ADMIN_ROLE,
        ep,
        smartAccount,
        cfl,
        trustedForwarder: smartAccount,
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

    callForwardMethod: async (ret, method, target, methodCall) => {
      const { cfl, smartAccount, bridge23, ep } = ret;
      const forwardCall = cfl.interface.encodeFunctionData(method, [await ethers.resolveAddress(target), methodCall]);
      const executeCall = smartAccount.interface.encodeFunctionData("execute", [
        await ethers.resolveAddress(cfl),
        0,
        forwardCall,
      ]);
      const nonce = await ret.smartAccount.getNonce();
      const userOp = [
        await ethers.resolveAddress(ret.smartAccount),
        nonce,
        ethers.toUtf8Bytes(""),
        executeCall,
        packAccountGasLimits(999999, 999999),
        999999,
        packAccountGasLimits(1e9, 1e9),
        ethers.toUtf8Bytes(""),
      ];
      const userOpHash = await ep.getUserOpHash([...userOp, ethers.toUtf8Bytes("")]);
      const signature = await bridge23.signMessage(ethers.getBytes(userOpHash));
      return ep.handleOps([[...userOp, signature]], bridge23);
    },
    usesAA: true,
    expectCustomError: async (ret, operation, contract, errorName) => {
      await expect(operation)
        .to.emit(ret.ep, "UserOperationRevertReason")
        .withArgs(anyValue, anyValue, anyValue, captureAny.value);
      expect(captureAny.lastValue.startsWith(contract.interface.getError(errorName).selector)).to.equal(true);
      // errorArgs not checked
    },
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
      await variant.expectCustomError(
        ret,
        variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall),
        cfl,
        "UnauthorizedForward",
        [bridge23, rm, newPolicyFakeSelector]
      );

      await setupAMRole(acMgr.connect(admin), cfl, roles, "USER_OP_SIGNER", [newPolicyFakeSelector]);
      await acMgr.connect(admin).grantRole(roles.USER_OP_SIGNER, bridge23, 0);

      await variant.expectCustomError(
        ret,
        variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall),
        cfl,
        "ERC20InsufficientBalance",
        [cfl, 0, captureAny.uint]
      );

      // The amount that fails is the purePremium, not the chargedPremium - So I accept 10% difference
      if (!variant.usesAA) expect(captureAny.lastUint).to.closeTo(chargedPremium, _A(0.1) * chargedPremium);

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
      await variant.expectCustomError(
        ret,
        variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall),
        cfl,
        "UnauthorizedForward",
        [bridge23, rm, ownedPolicyFakeSelector]
      );

      await setupAMRole(acMgr.connect(admin), cfl, roles, "USER_OP_SIGNER", [ownedPolicyFakeSelector]);

      await expect(variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall))
        .to.emit(pool, "NewPolicy")
        .withArgs(rm, captureAny.value);
      const newPolicy = captureAny.lastValue;

      expect(newPolicy.premium).to.closeTo(chargedPremium, _A("0.0001"));

      expect(await pool.ownerOf(newPolicy.id)).to.equal(anon);
    });

    variant.tagit("should be able to change the yield vault when there are no funds", async function () {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, TestERC4626, currency, cflAdmin, yieldVault } = ret;

      expect(await currency.balanceOf(yieldVault)).to.equal(0);
      expect(await currency.balanceOf(cfl)).to.equal(0);
      expect(await currency.allowance(cfl, yieldVault)).to.equal(MaxUint256);

      const newVault = await TestERC4626.deploy("New Yield Vault", "NEWYIELD", currency);

      await expect(cfl.connect(cflAdmin).setYieldVault(newVault, false))
        .to.emit(cfl, "YieldVaultChanged")
        .withArgs(yieldVault, newVault);
      expect(await cfl.yieldVault()).to.equal(newVault);

      expect(await currency.balanceOf(newVault)).to.equal(0);

      expect(await currency.allowance(cfl, yieldVault)).to.equal(0); // Original vault allowance approval reseted
      expect(await currency.allowance(cfl, newVault)).to.equal(MaxUint256); // New vault allowance approval MaxUint256
    });

    variant.tagit("should be able to change the yield vault when there funds in the yield vault", async function () {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, TestERC4626, currency, cflAdmin, yieldVault, lp } = ret;

      expect(await yieldVault.totalAssets()).to.equal(0);
      expect(await cfl.totalAssets()).to.equal(0);

      await currency.connect(lp).approve(cfl, _A(1000));
      await cfl.connect(lp).deposit(_A(1000), lp);

      expect(await cfl.totalAssets()).to.equal(_A(1000));

      await expect(() => cfl.connect(cflAdmin).depositIntoYieldVault(_A(700))).to.changeTokenBalances(
        currency,
        [cfl, yieldVault],
        [-_A(700), _A(700)]
      );

      expect(await yieldVault.totalAssets()).to.equal(_A(700));

      const newVault = await TestERC4626.deploy("New Yield Vault", "NEWYIELD", currency);

      await expect(cfl.connect(cflAdmin).setYieldVault(newVault, false))
        .to.emit(cfl, "YieldVaultChanged")
        .withArgs(yieldVault, newVault);
      expect(await cfl.yieldVault()).to.equal(newVault);

      expect(await yieldVault.totalAssets()).to.equal(0); // Cheking the funds of the old vault were deinvested.
      expect(await cfl.totalAssets()).to.equal(_A(1000)); // Funds are still in the CFL

      expect(await newVault.totalAssets()).to.equal(0); // Balance not re-invested in the new vault after change

      // Check new vault works fine
      await expect(() => cfl.connect(cflAdmin).depositIntoYieldVault(_A(400))).to.changeTokenBalances(
        currency,
        [cfl, newVault],
        [-_A(400), _A(400)]
      );
      expect(await newVault.totalAssets()).to.equal(_A(400));
      expect(await currency.balanceOf(cfl)).to.equal(_A(600));
    });

    variant.tagit(
      "Should allow partial & MaxUint256 deposit into yield vault, and fail if there are not enough funds",
      async function () {
        const ret = await helpers.loadFixture(variant.fixture);
        const { cfl, currency, cflAdmin, yieldVault, lp } = ret;

        expect(await yieldVault.totalAssets()).to.equal(0);
        expect(await cfl.totalAssets()).to.equal(0);

        await currency.connect(lp).approve(cfl, _A(1000));
        await cfl.connect(lp).deposit(_A(1000), lp);

        expect(await cfl.totalAssets()).to.equal(_A(1000));

        await expect(() => cfl.connect(cflAdmin).depositIntoYieldVault(_A(700))).to.changeTokenBalances(
          currency,
          [cfl, yieldVault],
          [-_A(700), _A(700)]
        );

        expect(await yieldVault.totalAssets()).to.equal(_A(700));

        await expect(cfl.connect(cflAdmin).depositIntoYieldVault(_A(400))).to.be.revertedWithCustomError(
          cfl,
          "NotEnoughCash"
        );

        await expect(
          () => cfl.connect(cflAdmin).depositIntoYieldVault(MaxUint256) // Should be the _A(300) left on CFL
        ).to.changeTokenBalances(currency, [cfl, yieldVault], [-_A(300), _A(300)]);

        expect(await yieldVault.totalAssets()).to.equal(_A(1000));
      }
    );

    variant.tagit(
      "Should allow partial & MaxUint256 withdraws from yield vault, fails if there are not enough funds",
      async function () {
        const ret = await helpers.loadFixture(variant.fixture);
        const { cfl, currency, cflAdmin, yieldVault, lp } = ret;

        expect(await yieldVault.totalAssets()).to.equal(0);
        expect(await cfl.totalAssets()).to.equal(0);

        await currency.connect(lp).approve(cfl, _A(1000));
        await cfl.connect(lp).deposit(_A(1000), lp);

        expect(await cfl.totalAssets()).to.equal(_A(1000));

        await expect(() => cfl.connect(cflAdmin).depositIntoYieldVault(MaxUint256)).to.changeTokenBalances(
          currency,
          [cfl, yieldVault],
          [-_A(1000), _A(1000)]
        );

        expect(await yieldVault.totalAssets()).to.equal(_A(1000));

        await expect(() => cfl.connect(cflAdmin).withdrawFromYieldVault(_A(300))).to.changeTokenBalances(
          currency,
          [cfl, yieldVault],
          [_A(300), -_A(300)]
        );
        expect(await yieldVault.totalAssets()).to.equal(_A(700));

        await expect(cfl.connect(cflAdmin).withdrawFromYieldVault(_A(800))).to.be.revertedWithCustomError(
          cfl,
          "NotEnoughCash"
        );

        await expect(
          () => cfl.connect(cflAdmin).withdrawFromYieldVault(MaxUint256) // Should be the _A(700) left on Yield Vault
        ).to.changeTokenBalances(currency, [cfl, yieldVault], [_A(700), -_A(700)]);
        expect(await yieldVault.totalAssets()).to.equal(0);
      }
    );

    // Missing: tests related to setYieldVault(..., true) when yieldVault.maxWithdraw() != yieldVault.totalAssets()

    variant.tagit("should withdraw from yield vault when cash is insufficient", async function () {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, yieldVault, lp, cflAdmin } = ret;

      await currency.connect(lp).approve(cfl, _A(1000));
      await cfl.connect(lp).deposit(_A(1000), lp);

      await expect(() => cfl.connect(cflAdmin).depositIntoYieldVault(_A(800))).to.changeTokenBalances(
        currency,
        [cfl, yieldVault],
        [-_A(800), _A(800)]
      );

      expect(await cfl.totalAssets()).to.equal(_A(1000));
      expect(await yieldVault.totalAssets()).to.equal(_A(800));

      await expect(() => cfl.connect(lp).withdraw(_A(600), lp, lp)).to.changeTokenBalances(
        currency,
        [cfl, lp, yieldVault],
        [-_A(200), _A(600), -_A(400)]
      );

      expect(await cfl.totalAssets()).to.equal(_A(400));
      expect(await yieldVault.totalAssets()).to.equal(_A(400));
    });

    variant.tagit("should fail to withdraw when CFL has not enough funds due to debt", async function () {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp, cflAdmin, rm, pool, bridge23, acMgr, roles, admin } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));

      const { newPolicyCall, selector } = await variant.createPolicyCall(ret, {});
      const newPolicyFakeSelector = await cfl.makeFakeSelector(rm, selector);

      await setupAMRole(acMgr.connect(admin), cfl, roles, "USER_OP_SIGNER", [newPolicyFakeSelector]);
      await acMgr.connect(admin).grantRole(roles.USER_OP_SIGNER, bridge23, 0);

      await currency.connect(lp).approve(cfl, _A(1000));
      await cfl.connect(lp).deposit(_A(1000), lp);

      await expect(variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall))
        .to.emit(pool, "NewPolicy")
        .withArgs(rm, captureAny.value);
      const newPolicy = captureAny.lastValue;

      await expect(cfl.connect(lp).withdraw(_A(1000), lp, lp)).to.be.revertedWithCustomError(
        cfl,
        "ERC4626ExceededMaxWithdraw"
      );

      const availableCash = await currency.balanceOf(cfl);
      expect(availableCash).to.equal(_A(1000) - newPolicy.premium);

      expect(await cfl.maxWithdraw(lp)).to.equal(availableCash);
      await expect(cfl.connect(lp).withdraw(availableCash, lp, lp)).to.not.be.reverted;
    });

    variant.tagit(
      "forwardNewPolicy deinvest from yieldVault if cash balance is less than minLiquidity",
      async function () {
        const ret = await helpers.loadFixture(variant.fixture);
        const { cfl, currency, yieldVault, lp, cflAdmin, rm, pool, bridge23, acMgr, roles, admin } = ret;

        // Deposit 1000 and send 800 to the yieldVault
        await currency.connect(lp).approve(cfl, _A(300));
        await cfl.connect(lp).deposit(_A(300), lp);
        await cfl.connect(cflAdmin).depositIntoYieldVault(_A(200));

        // Set minLiquidity = 250, so before any forwardNewPolicy it will try to have that amount in cash
        await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(250));

        let { newPolicyCall, selector } = await variant.createPolicyCall(ret, { payout: _A(1000), premium: _A(60) });
        const newPolicyFakeSelector = await cfl.makeFakeSelector(rm, selector);

        await setupAMRole(acMgr.connect(admin), cfl, roles, "USER_OP_SIGNER", [newPolicyFakeSelector]);
        await acMgr.connect(admin).grantRole(roles.USER_OP_SIGNER, bridge23, 0);

        await expect(variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall))
          .to.emit(pool, "NewPolicy")
          .withArgs(rm, captureAny.value)
          .to.emit(yieldVault, "Withdraw")
          .withArgs(cfl, cfl, cfl, captureAny.uint, anyUint);
        let newPolicy = captureAny.lastValue;

        expect(captureAny.lastUint).to.equal(_A(150)); // From 100 that already had in cash to 250

        expect(await currency.balanceOf(cfl)).to.equal(_A(250) - newPolicy.premium);

        // Then if I create another policy it will try to withdraw more, but since only 50 left in the yieldVault
        // if will withdraw only 50 withdraw failing
        newPolicyCall = (await variant.createPolicyCall(ret, { payout: _A(1000), premium: _A(60) })).newPolicyCall;
        await expect(variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall))
          .to.emit(pool, "NewPolicy")
          .withArgs(rm, captureAny.value)
          .to.emit(yieldVault, "Withdraw")
          .withArgs(cfl, cfl, cfl, captureAny.uint, anyUint);
        newPolicy = captureAny.lastValue;

        expect(captureAny.lastUint).to.equal(_A(50)); // Just 50 remaining in the yieldVault
        expect(await currency.balanceOf(cfl)).to.equal(_A(300) - _A(60 * 2));
        expect(await currency.balanceOf(yieldVault)).to.equal(0);
      }
    );

    variant.tagit(
      "Withdraw should deinvest from yield vault when cash is insufficient & fail when funds not enough due to debt",
      async function () {
        const ret = await helpers.loadFixture(variant.fixture);
        const { cfl, currency, yieldVault, lp, cflAdmin, rm, pool, bridge23, acMgr, roles, admin } = ret;

        // Deposit 1000 and send 800 to the yieldVault
        await currency.connect(lp).approve(cfl, _A(1000));
        await cfl.connect(lp).deposit(_A(1000), lp);
        await cfl.connect(cflAdmin).depositIntoYieldVault(_A(800));

        await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));

        const { newPolicyCall, selector } = await variant.createPolicyCall(ret, { payout: _A(1000) });
        const newPolicyFakeSelector = await cfl.makeFakeSelector(rm, selector);

        await setupAMRole(acMgr.connect(admin), cfl, roles, "USER_OP_SIGNER", [newPolicyFakeSelector]);
        await acMgr.connect(admin).grantRole(roles.USER_OP_SIGNER, bridge23, 0);

        await expect(variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall))
          .to.emit(pool, "NewPolicy")
          .withArgs(rm, captureAny.value);
        const newPolicy = captureAny.lastValue;

        await cfl.connect(lp).withdraw(_A(600), lp, lp);
        expect(await cfl.maxWithdraw(lp)).to.equal(_A(400) - newPolicy.premium);

        expect(await yieldVault.totalAssets()).to.be.equal(_A(400) - newPolicy.premium);

        await expect(cfl.connect(lp).withdraw(_A(400), lp, lp)).to.be.revertedWithCustomError(
          cfl,
          "ERC4626ExceededMaxWithdraw"
        );

        await expect(cfl.connect(lp).withdraw(await cfl.maxWithdraw(lp), lp, lp)).not.to.be.reverted;

        expect(await yieldVault.totalAssets()).to.be.equal(0);
        expect(await cfl.totalAssets()).to.be.equal(newPolicy.premium);
      }
    );

    variant.tagit("Should restrict onXXX methods to be callable only by the PolicyPool", async function () {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, rm, cflAdmin } = ret;

      await expect(cfl.connect(cflAdmin).onPolicyExpired(rm, ZeroAddress, 1)).to.be.revertedWithCustomError(
        cfl,
        "OnlyPolicyPool"
      );

      await expect(cfl.connect(cflAdmin).onPolicyReplaced(rm, ZeroAddress, 1, _A(10))).to.be.revertedWithCustomError(
        cfl,
        "OnlyPolicyPool"
      );

      await expect(cfl.connect(cflAdmin).onPayoutReceived(rm, ZeroAddress, 1, _A(10))).to.be.revertedWithCustomError(
        cfl,
        "OnlyPolicyPool"
      );
    });

    variant.tagit("Can forward a single new policy using batch method", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool, bridge23, acMgr, roles, admin } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));

      const { newPolicyCall, chargedPremium, selector } = await variant.createPolicyCall(ret, {});

      const newPolicyFakeSelector = await cfl.makeFakeSelector(rm, selector);

      await variant.expectCustomError(
        ret,
        variant.callForwardMethod(ret, "forwardNewPolicyBatch", rm, [newPolicyCall]),
        cfl,
        "UnauthorizedForward",
        [bridge23, rm, newPolicyFakeSelector]
      );

      await setupAMRole(acMgr.connect(admin), cfl, roles, "USER_OP_SIGNER", [newPolicyFakeSelector]);
      await acMgr.connect(admin).grantRole(roles.USER_OP_SIGNER, bridge23, 0);

      await variant.expectCustomError(
        ret,
        variant.callForwardMethod(ret, "forwardNewPolicyBatch", rm, [newPolicyCall]),
        cfl,
        "ERC20InsufficientBalance",
        [cfl, 0, captureAny.uint]
      );

      if (!variant.usesAA) expect(captureAny.lastUint).to.closeTo(chargedPremium, _A(0.1) * chargedPremium);

      await currency.connect(lp2).approve(cfl, _A(100));
      await cfl.connect(lp2).deposit(_A(100), lp2);

      await expect(variant.callForwardMethod(ret, "forwardNewPolicyBatch", rm, [newPolicyCall]))
        .to.emit(pool, "NewPolicy")
        .withArgs(rm, captureAny.value);

      const newPolicy = captureAny.lastValue;
      expect(newPolicy.premium).to.closeTo(chargedPremium, _A("0.0001"));

      expect(await pool.ownerOf(newPolicy.id)).to.equal(cfl);
    });

    variant.tagit("Can forward multiple new policies using batch method", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool, bridge23, acMgr, roles, admin } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));

      const policyCalls = [];
      const selectors = [];
      const totalChargedPremium = [];

      for (let i = 0; i < 3; i++) {
        const { newPolicyCall, chargedPremium, selector } = await variant.createPolicyCall(ret, {});
        policyCalls.push(newPolicyCall);
        selectors.push(selector);
        totalChargedPremium.push(chargedPremium);
      }

      const batchFakeSelector = await cfl.makeFakeSelector(rm, selectors[0]);

      await variant.expectCustomError(
        ret,
        variant.callForwardMethod(ret, "forwardNewPolicyBatch", rm, policyCalls),
        cfl,
        "UnauthorizedForward",
        [bridge23, rm, batchFakeSelector]
      );

      await setupAMRole(acMgr.connect(admin), cfl, roles, "USER_OP_SIGNER", [batchFakeSelector]);
      await acMgr.connect(admin).grantRole(roles.USER_OP_SIGNER, bridge23, 0);

      await variant.expectCustomError(
        ret,
        variant.callForwardMethod(ret, "forwardNewPolicyBatch", rm, policyCalls),
        cfl,
        "ERC20InsufficientBalance",
        [cfl, 0, captureAny.uint]
      );

      await currency.connect(lp2).approve(cfl, _A(1000));
      await cfl.connect(lp2).deposit(_A(1000), lp2);

      await expect(variant.callForwardMethod(ret, "forwardNewPolicyBatch", rm, policyCalls))
        .to.emit(pool, "NewPolicy")
        .withArgs(rm, anyValue)
        .to.emit(pool, "NewPolicy")
        .withArgs(rm, anyValue)
        .to.emit(pool, "NewPolicy")
        .withArgs(rm, anyValue)
        .to.emit(cfl, "DebtChanged");

      // Debería verificar que se emita el DebtChanged, se necesita una función para saber SlotSize, SlotIndex? o como puedo calcularlos?
      // Al querer hacer el assert de los args en la emisión de DebtChanged me da error por una pequeña diferencia, hay manera de hacer un closeTo?

      const totalPremiumRequired = totalChargedPremium.reduce((acc, val) => acc + val, _A(0));
      expect(await cfl.currentDebt()).to.be.closeTo(totalPremiumRequired, _A(0.1));
    });

    variant.tagit("Does nothing when calling forwardNewPolicyBatch with an empty array", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, rm, cflAdmin, pool } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));

      const emptyPolicyCalls = [];
      const initialDebt = await cfl.currentDebt();

      await expect(variant.callForwardMethod(ret, "forwardNewPolicyBatch", rm, emptyPolicyCalls))
        .to.not.emit(pool, "NewPolicy")
        .to.not.emit(cfl, "DebtChanged");

      expect(await cfl.currentDebt()).to.equal(initialDebt);
    });

    variant.tagit("Can resolve a single policy using batch method", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool, bridge23, acMgr, roles, admin } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));
      await currency.connect(lp2).approve(cfl, _A(100));
      await cfl.connect(lp2).deposit(_A(100), lp2);

      const { newPolicyCall, chargedPremium, selector } = await variant.createPolicyCall(ret, {});
      const newPolicyFakeSelector = await cfl.makeFakeSelector(rm, selector);

      await setupAMRole(acMgr.connect(admin), cfl, roles, "USER_OP_SIGNER", [newPolicyFakeSelector]);
      await acMgr.connect(admin).grantRole(roles.USER_OP_SIGNER, bridge23, 0);

      const createTx = await variant.callForwardMethod(ret, "forwardNewPolicyBatch", rm, [newPolicyCall]);
      await expect(createTx).to.emit(pool, "NewPolicy").withArgs(rm, captureAny.value);
      const newPolicy = captureAny.lastValue;

      const payout = chargedPremium;
      const resolveCall = rm.interface.encodeFunctionData("resolvePolicy", [newPolicy, payout]);
      const resolveSelector = rm.interface.getFunction("resolvePolicy").selector;
      const resolveFakeSelector = await cfl.makeFakeSelector(rm, resolveSelector);

      await variant.expectCustomError(
        ret,
        variant.callForwardMethod(ret, "forwardResolvePolicyBatch", rm, [resolveCall]),
        cfl,
        "UnauthorizedForward",
        [bridge23, rm, resolveFakeSelector]
      );

      await setupAMRole(acMgr.connect(admin), cfl, roles, "USER_OP_SIGNER", [resolveFakeSelector]);
      await acMgr.connect(admin).grantRole(roles.USER_OP_SIGNER, bridge23, 0);

      const initialDebt = await cfl.currentDebt();
      await expect(variant.callForwardMethod(ret, "forwardResolvePolicyBatch", rm, [resolveCall]))
        .to.emit(pool, "PolicyResolved")
        .withArgs(rm, newPolicy.id);

      const finalDebt = await cfl.currentDebt();
      expect(finalDebt).to.be.lte(initialDebt);
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
