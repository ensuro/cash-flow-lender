const { expect } = require("chai");
const {
  amountFunction,
  tagitVariant,
  _W,
  getAddress,
  captureAny,
  newCaptureAny,
  getTransactionEvent,
} = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { DAY, WEEK } = require("@ensuro/utils/js/constants");
const {
  deployPool,
  deployPremiumsAccount,
  addRiskModule,
  addEToken,
  makeAllPublic,
  makeCFLForwardingPublic,
} = require("../js/binary-ensuro-test-utils");
const { packAccountGasLimits } = require("@ensuro/account-abstraction/js/userOp.js");
const {
  makeFTUWInputData,
  makeFTUWReplacementInputData,
  makeFTUWCancelInputData,
  defaultTestParams,
  getPremium,
} = require("@ensuro/core/js/utils");

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

const TargetStatus = {
  inactive: 0,
  active: 1,
  deprecated: 2,
  suspended: 3,
};

const OverrideOption = {
  deposit: 0,
  mint: 1,
  withdraw: 2,
  redeem: 3,
};

async function setUp() {
  const [, lp, lp2, anon, admin, cflAdmin, bridge23, bo] = await ethers.getSigners();
  const currency = await initCurrency(
    { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(50000) },
    [lp, lp2, bo],
    [_A(INITIAL), _A(INITIAL), _A(INITIAL)]
  );

  const adminAddr = await ethers.resolveAddress(admin);
  const AccessManagedProxy = await ethers.getContractFactory("AccessManagedProxy");
  const AccessManager = await ethers.getContractFactory("AccessManager");
  const acMgr = await AccessManager.deploy(admin);

  const pool = await deployPool({
    currency: currency,
    treasuryAddress: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199",
  });
  pool._A = _A;

  const etk = await addEToken(pool, {});
  const premiumsAccount = await deployPremiumsAccount(pool, { srEtk: etk });

  // Provide some liquidity
  await currency.connect(lp).approve(pool, _A(5000));
  await pool.connect(lp).deposit(etk, _A(5000), lp);

  const TestERC4626 = await ethers.getContractFactory("TestERC4626");
  const CashFlowLender = await ethers.getContractFactory("CashFlowLender");
  const yieldVault = await TestERC4626.deploy("Yield Vault", "YIELD", currency);

  return {
    currency,
    adminAddr,
    lp,
    lp2,
    anon,
    bo,
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
  };
}

async function addRMToPool({ premiumsAccount, pool, RiskModule, underwriterFactory }) {
  const rm = await addRiskModule(pool, premiumsAccount, RiskModule, {
    underwriterFactory: underwriterFactory || "@ensuro/core/FullTrustedUW",
  });
  return rm;
}

async function vaultDeposit(vault, lp, amount, currency = undefined) {
  await currency.connect(lp).approve(vault, amount);
  return vault.connect(lp).deposit(amount, lp);
}

async function forwardPolicies(variant, ret, policyParams) {
  const { rm, pool } = ret;
  if (typeof policyParams === "number") {
    // As a shortcut, accepts the number of policies, if there are all with default params
    policyParams = Array(policyParams).fill({});
  }

  let totalChargedPremium = 0n;

  const newPolicyCalls = [];
  for (const pp of policyParams) {
    const { newPolicyCall, chargedPremium } = await variant.createPolicyCall(ret, pp);
    totalChargedPremium += chargedPremium;
    newPolicyCalls.push(newPolicyCall);
  }

  const callPromise = variant.callForwardMethod(ret, "forwardNewPolicyBatch", rm, newPolicyCalls);

  async function getPolicies() {
    const receipt = await (await callPromise).wait();
    const newPolicyEvents = getTransactionEvent(pool.interface, receipt, "NewPolicy", false, getAddress(pool));
    return newPolicyEvents.map((evt) => evt.args.policy);
  }
  return { callPromise, getPolicies, totalChargedPremium };
}

let uniqueInternalId = 1000; // Variable to generate consecutive internalIds

const directTrustfullRM = {
  name: "NoTrustedForwarder+Trustful",
  fixture: async (rmClass) => {
    const ret = await setUp();
    const { admin, CashFlowLender, yieldVault, acMgr, pool, AccessManagedProxy, premiumsAccount, bridge23 } = ret;

    const cfl = await hre.upgrades.deployProxy(CashFlowLender, [NAME, SYMB, await ethers.resolveAddress(yieldVault)], {
      kind: "uups",
      unsafeAllow: ["delegatecall", "missing-initializer-call"],
      proxyFactory: AccessManagedProxy,
      constructorArgs: [ZeroAddress, await ethers.resolveAddress(pool)],
      deployFunction: async (hre_, opts, factory, ...args) => ozUpgradesDeploy(hre_, opts, factory, ...args, acMgr, []),
    });
    await makeAllPublic(cfl, acMgr.connect(admin));

    const RiskModule = await ethers.getContractFactory(rmClass || "@ensuro/core/RiskModule");
    const rm = await addRMToPool({
      premiumsAccount,
      pool,
      RiskModule,
      underwriterFactory: "@ensuro/core/FullTrustedUW",
    });
    await pool.connect(admin).setExposureLimit(rm, 2n ** 128n - 1n);
    await makeCFLForwardingPublic(cfl, rm, acMgr.connect(admin));

    return {
      smartAccount: bridge23, // The bridge23 and the smart account are the same in this variant
      cfl,
      trustedForwarder: ZeroAddress,
      RiskModule,
      rm,
      ...ret,
    };
  },

  createPolicyCall: async ({ rm, cfl }, policyParams, onBehalfOf = undefined) => {
    const premium = policyParams.premium || MaxUint256;
    const payout = policyParams.payout || _A(100);
    const lossProb = policyParams.lossProb || _W("0.05");
    const expiration = policyParams.expiration || (await helpers.time.latest()) + 30 * DAY;
    // eslint-disable-next-line no-plusplus
    const internalId = policyParams.internalId || ++uniqueInternalId;
    const start = policyParams.start || (await helpers.time.latest());
    const params = defaultTestParams(policyParams.params || {});
    const chargedPremium =
      premium === MaxUint256 ? await rm.getMinimumPremium(payout, lossProb, start, expiration, params) : premium;
    const method = "newPolicy";
    const inputData = makeFTUWInputData({ payout, premium, lossProb, expiration, internalId, params });
    const newPolicyCall = rm.interface.encodeFunctionData(method, [inputData, getAddress(onBehalfOf || cfl)]);
    return { newPolicyCall, chargedPremium, selector: rm.interface.getFunction(method).selector };
  },

  replacePolicyCall: async ({ rm }, oldPolicy, policyParams) => {
    // returns the call, selector, and premium amount
    const premium = policyParams.premium || MaxUint256;
    const payout = policyParams.payout || _A(100);
    const lossProb = policyParams.lossProb || _W("0.05");
    const expiration = Math.max(
      Number(oldPolicy.expiration),
      policyParams.expiration || (await helpers.time.latest()) + 30 * DAY
    );
    // eslint-disable-next-line no-plusplus
    const internalId = policyParams.internalId || ++uniqueInternalId;
    const start = oldPolicy.start || (await helpers.time.latest());
    const params = defaultTestParams(policyParams.params || {});
    const oldPolicyPremium = getPremium(oldPolicy);
    const chargedPremium =
      (premium === MaxUint256 ? await rm.getMinimumPremium(payout, lossProb, start, expiration, params) : premium) -
      oldPolicyPremium;
    const method = "replacePolicy";
    const oldPolicyTuple = [
      oldPolicy.id,
      oldPolicy.payout,
      oldPolicy.jrScr,
      oldPolicy.srScr,
      oldPolicy.lossProb,
      oldPolicy.purePremium,
      oldPolicy.ensuroCommission,
      oldPolicy.partnerCommission,
      oldPolicy.jrCoc,
      oldPolicy.srCoc,
      oldPolicy.start,
      oldPolicy.expiration,
    ];
    const inputData = makeFTUWReplacementInputData({
      oldPolicy: oldPolicyTuple,
      payout,
      premium,
      lossProb,
      expiration,
      internalId,
      params,
    });
    const replacePolicyCall = rm.interface.encodeFunctionData(method, [inputData]);
    return { replacePolicyCall, chargedPremium, selector: rm.interface.getFunction(method).selector };
  },

  callForwardMethod: async (ret, method, target, methodCall) =>
    ret.cfl.connect(ret.smartAccount)[method](target, methodCall),
  expectCustomError: async (_, operation, contract, errorName, errorArgs) =>
    expect(operation)
      .to.be.revertedWithCustomError(contract, errorName)
      .withArgs(...errorArgs),
  usesAA: false,
};

const aaTrustfullRM = {
  name: "SmartAccountForwarder+Trustful",
  fixture: async (rmClass) => {
    const ret = await setUp();
    const { admin, CashFlowLender, yieldVault, acMgr, pool, AccessManagedProxy, premiumsAccount, bridge23 } = ret;

    const EntryPoint = await ethers.getContractFactory("EntryPoint");
    const ep = await EntryPoint.deploy();
    const ERC2771ForwarderAccount = await ethers.getContractFactory("ERC2771ForwarderAccount");
    const smartAccount = await ERC2771ForwarderAccount.deploy(ep, admin, [bridge23]);

    await ep.depositTo(smartAccount, { value: _W(1) });

    // Create and setup the CFL
    const cfl = await hre.upgrades.deployProxy(CashFlowLender, [NAME, SYMB, await ethers.resolveAddress(yieldVault)], {
      kind: "uups",
      unsafeAllow: ["delegatecall", "missing-initializer-call"],
      proxyFactory: AccessManagedProxy,
      constructorArgs: [await ethers.resolveAddress(smartAccount), await ethers.resolveAddress(pool)],
      deployFunction: async (hre_, opts, factory, ...args) => ozUpgradesDeploy(hre_, opts, factory, ...args, acMgr, []),
    });

    await makeAllPublic(cfl, acMgr.connect(admin));

    const RiskModule = await ethers.getContractFactory(rmClass || "@ensuro/core/RiskModule");
    const rm = await addRMToPool({
      premiumsAccount,
      pool,
      RiskModule,
      underwriterFactory: "@ensuro/core/FullTrustedUW",
    });
    await pool.connect(admin).setExposureLimit(rm, 2n ** 128n - 1n);
    await makeCFLForwardingPublic(cfl, rm, acMgr.connect(admin));

    return {
      ep,
      smartAccount,
      cfl,
      trustedForwarder: smartAccount,
      RiskModule,
      rm,
      ...ret,
    };
  },

  createPolicyCall: directTrustfullRM.createPolicyCall,
  replacePolicyCall: directTrustfullRM.replacePolicyCall,

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
    const errorSelector = captureAny.lastValue.slice(0, 10);
    const expectedSelector = contract.interface.getError(errorName).selector;
    if (errorSelector !== expectedSelector) {
      for (const errorFragment of contract.interface.fragments.filter((f) => f.type === "error")) {
        if (errorFragment.selector === errorSelector) {
          expect(errorFragment.name).to.equal(errorName);
        }
      }
    }
    expect(expectedSelector).to.equal(errorSelector);
    // errorArgs not checked
  },
};

const aaFullRM = {
  name: "SmartAccountForwarder+FullSignedUW",
  fixture: async () => {
    const ret = await aaTrustfullRM.fixture("@ensuro/core/RiskModule");
    const { bo, cfl, acMgr, admin, pool, premiumsAccount } = ret;
    const fullSigner = bo;

    const FullSignedUW = await ethers.getContractFactory("@ensuro/core/FullSignedUW");
    const fullSignedUW = await FullSignedUW.deploy();
    await fullSignedUW.waitForDeployment();

    const RiskModule = await ethers.getContractFactory("@ensuro/core/RiskModule");
    const rmImpl = await RiskModule.deploy(pool, premiumsAccount);
    await rmImpl.waitForDeployment();

    const AccessManagedProxy = await ethers.getContractFactory("AccessManagedProxy");
    const defaultWallet = "0xdD2FD4581271e230360230F9337D5c0430Bf44C0";
    const initData = rmImpl.interface.encodeFunctionData("initialize", [
      await ethers.resolveAddress(fullSignedUW),
      defaultWallet,
    ]);
    const rmProxy = await AccessManagedProxy.deploy(await ethers.resolveAddress(rmImpl), initData, acMgr, []);
    await rmProxy.waitForDeployment();

    const rm = RiskModule.attach(rmProxy);
    await makeAllPublic(rm, acMgr.connect(admin));
    await makeCFLForwardingPublic(cfl, rm, acMgr.connect(admin));

    await pool.addComponent(rm, 2);
    await pool.connect(admin).setExposureLimit(rm, 2n ** 128n - 1n);

    return {
      fullSigner,
      rm,
      ...ret,
    };
  },

  createPolicyCall: async ({ rm, cfl, fullSigner }, policyParams, onBehalfOf = undefined) => {
    const premium = policyParams.premium || MaxUint256;
    const payout = policyParams.payout || _A(100);
    const lossProb = policyParams.lossProb || _W("0.05");
    const expiration = policyParams.expiration || (await helpers.time.latest()) + 30 * DAY;
    // eslint-disable-next-line no-plusplus
    const internalId = policyParams.internalId || ++uniqueInternalId;
    const start = policyParams.start || (await helpers.time.latest());
    const defaultParams = {
      moc: _W(1.1),
      jrCollRatio: 0n,
      collRatio: _W(0.8),
      ensuroPpFee: _W(0.1),
      ensuroCocFee: _W(0.1),
      jrRoc: _W("0.4"),
      srRoc: _W("0.1"),
    };
    const params = defaultTestParams({ ...defaultParams, ...(policyParams.params || {}) });
    const chargedPremium =
      premium === MaxUint256 ? await rm.getMinimumPremium(payout, lossProb, start, expiration, params) : premium;
    const method = "newPolicy";

    const payload = makeFTUWInputData({ payout, premium, lossProb, expiration, internalId, params });

    const signature = await fullSigner.signMessage(payload);

    const inputData = ethers.concat([payload, signature]);

    const newPolicyCall = rm.interface.encodeFunctionData(method, [inputData, getAddress(onBehalfOf || cfl)]);
    return { newPolicyCall, chargedPremium, selector: rm.interface.getFunction(method).selector };
  },

  callForwardMethod: aaTrustfullRM.callForwardMethod,
  usesAA: true,
  rmIsFull: true,
  expectCustomError: aaTrustfullRM.expectCustomError,
};

const directFullRM = {
  name: "NoTrustedForwarder+FullSignedUW",
  fixture: async () => {
    const ret = await directTrustfullRM.fixture("@ensuro/core/RiskModule");
    const { bo, cfl, acMgr, admin, pool, premiumsAccount } = ret;
    const fullSigner = bo;

    const FullSignedUW = await ethers.getContractFactory("@ensuro/core/FullSignedUW");
    const fullSignedUW = await FullSignedUW.deploy();
    await fullSignedUW.waitForDeployment();

    const RiskModule = await ethers.getContractFactory("@ensuro/core/RiskModule");
    const rmImpl = await RiskModule.deploy(pool, premiumsAccount);
    await rmImpl.waitForDeployment();

    const AccessManagedProxy = await ethers.getContractFactory("AccessManagedProxy");
    const defaultWallet = "0xdD2FD4581271e230360230F9337D5c0430Bf44C0";
    const initData = rmImpl.interface.encodeFunctionData("initialize", [
      await ethers.resolveAddress(fullSignedUW),
      defaultWallet,
    ]);
    const rmProxy = await AccessManagedProxy.deploy(await ethers.resolveAddress(rmImpl), initData, acMgr, []);
    await rmProxy.waitForDeployment();

    const rm = RiskModule.attach(rmProxy);
    await makeAllPublic(rm, acMgr.connect(admin));
    await makeCFLForwardingPublic(cfl, rm, acMgr.connect(admin));

    await pool.addComponent(rm, 2);
    await pool.connect(admin).setExposureLimit(rm, 2n ** 128n - 1n);

    return {
      fullSigner,
      rm,
      ...ret,
    };
  },
  createPolicyCall: aaFullRM.createPolicyCall,
  usesAA: false,
  rmIsFull: true,
  callForwardMethod: directTrustfullRM.callForwardMethod,
  expectCustomError: directTrustfullRM.expectCustomError,
};

const variants = [directTrustfullRM, aaTrustfullRM, aaFullRM, directFullRM];

variants.forEach((variant) => {
  // eslint-disable-next-line func-style
  const it = (testDescription, test) => tagitVariant(variant, false, testDescription, test);
  it.only = (testDescription, test) => tagitVariant(variant, true, testDescription, test);

  describe(`CashFlowLender contract tests - Variant:${variant.name}`, function () {
    it("Checks vault constructs with disabled initializer ", async () => {
      const { CashFlowLender, pool, yieldVault } = await helpers.loadFixture(variant.fixture);
      const newCFL = await CashFlowLender.deploy(ZeroAddress, pool);
      await expect(newCFL.deploymentTransaction()).to.emit(newCFL, "Initialized");
      await expect(newCFL.initialize(NAME, SYMB, yieldVault)).to.be.revertedWithCustomError(
        CashFlowLender,
        "InvalidInitialization"
      );
    });

    it("Initializes with the right values", async () => {
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

    it("Can forward a new policy", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool } = ret;

      const { newPolicyCall, chargedPremium } = await variant.createPolicyCall(ret, {});

      // Fails because target not yet added
      await variant.expectCustomError(
        ret,
        variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall),
        cfl,
        "TargetNotFound",
        [rm]
      );

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));

      await variant.expectCustomError(
        ret,
        variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall),
        cfl,
        "ERC20InsufficientBalance",
        [cfl, 0, captureAny.uint]
      );

      // The amount that fails is the purePremium, not the chargedPremium - So I accept 10% difference
      if (!variant.usesAA) expect(captureAny.lastUint).to.closeTo(chargedPremium, _A(0.1) * chargedPremium);

      await vaultDeposit(cfl, lp2, _A(100), currency);

      await expect(variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall))
        .to.emit(pool, "NewPolicy")
        .withArgs(rm, captureAny.value);
      const newPolicy = captureAny.lastValue;
      const calculatedPremium = getPremium(newPolicy);
      expect(calculatedPremium).to.closeTo(chargedPremium, _A("0.0001"));

      expect(await pool.ownerOf(newPolicy.id)).to.equal(cfl);
    });

    it("Can forward a new policy owned by someone else", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool, anon } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));

      const { newPolicyCall, chargedPremium } = await variant.createPolicyCall(ret, {}, anon);

      await vaultDeposit(cfl, lp2, _A(100), currency);

      await expect(variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall))
        .to.emit(pool, "NewPolicy")
        .withArgs(rm, captureAny.value);
      const newPolicy = captureAny.lastValue;

      const calculatedPremium = getPremium(newPolicy);
      expect(calculatedPremium).to.closeTo(chargedPremium, _A("0.0001"));

      expect(await pool.ownerOf(newPolicy.id)).to.equal(anon);
    });

    it("should be able to change the yield vault (to non-zero) when there are no funds", async function () {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, TestERC4626, currency, cflAdmin, yieldVault } = ret;

      expect(await currency.balanceOf(yieldVault)).to.equal(0);
      expect(await currency.balanceOf(cfl)).to.equal(0);
      expect(await currency.allowance(cfl, yieldVault)).to.equal(MaxUint256);

      const newVault = await TestERC4626.deploy("New Yield Vault", "NEWYIELD", currency);

      // Checks ZeroAddress vault is forbidden
      await expect(cfl.connect(cflAdmin).setYieldVault(ZeroAddress, false)).to.be.revertedWithCustomError(
        cfl,
        "YieldVaultIsRequired"
      );

      await expect(cfl.connect(cflAdmin).setYieldVault(newVault, false))
        .to.emit(cfl, "YieldVaultChanged")
        .withArgs(yieldVault, newVault);
      expect(await cfl.yieldVault()).to.equal(newVault);

      expect(await currency.balanceOf(newVault)).to.equal(0);

      expect(await currency.allowance(cfl, yieldVault)).to.equal(0); // Original vault allowance approval reseted
      expect(await currency.allowance(cfl, newVault)).to.equal(MaxUint256); // New vault allowance approval MaxUint256
    });

    it("should be able to change the yield vault when there funds in the yield vault", async function () {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, TestERC4626, currency, cflAdmin, yieldVault, lp } = ret;

      expect(await yieldVault.totalAssets()).to.equal(0);
      expect(await cfl.totalAssets()).to.equal(0);

      await vaultDeposit(cfl, lp, _A(1000), currency);

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

    it("can't change the yield vault, if some funds remain there unless forced", async function () {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, TestERC4626, currency, cflAdmin, yieldVault, lp } = ret;

      await vaultDeposit(cfl, lp, _A(1000), currency);

      await expect(() => cfl.connect(cflAdmin).depositIntoYieldVault(_A(700))).to.changeTokenBalances(
        currency,
        [cfl, yieldVault],
        [-_A(700), _A(700)]
      );

      expect(await yieldVault.totalAssets()).to.equal(_A(700));
      expect(await cfl.totalAssets()).to.equal(_A(1000));

      await yieldVault.setOverride(OverrideOption.withdraw, _A(500));

      const newVault = await TestERC4626.deploy("New Yield Vault", "NEWYIELD", currency);

      await expect(cfl.connect(cflAdmin).setYieldVault(newVault, false)).to.be.revertedWithCustomError(
        cfl,
        "CannotDeinvestYieldVault"
      );

      expect(await cfl.yieldVault()).to.equal(yieldVault);

      await expect(cfl.connect(cflAdmin).setYieldVault(newVault, true))
        .to.emit(cfl, "YieldVaultChanged")
        .withArgs(yieldVault, newVault);
      expect(await cfl.yieldVault()).to.equal(newVault);

      expect(await yieldVault.totalAssets()).to.equal(_A(200)); // Some funds were not withdrawn
      expect(await cfl.totalAssets()).to.equal(_A(800)); // 200 lost in the disconnected yield vault

      expect(await newVault.totalAssets()).to.equal(0); // Balance not re-invested in the new vault after change

      // Check new vault works fine
      await expect(() => cfl.connect(cflAdmin).depositIntoYieldVault(_A(300))).to.changeTokenBalances(
        currency,
        [cfl, newVault],
        [-_A(300), _A(300)]
      );
      expect(await newVault.totalAssets()).to.equal(_A(300));
      expect(await currency.balanceOf(cfl)).to.equal(_A(500));
    });

    it("Should allow partial & MaxUint256 deposit into yield vault, and fail if there are not enough funds", async function () {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, cflAdmin, yieldVault, lp } = ret;

      expect(await yieldVault.totalAssets()).to.equal(0);
      expect(await cfl.totalAssets()).to.equal(0);

      await vaultDeposit(cfl, lp, _A(1000), currency);

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
    });

    it("Should allow partial & MaxUint256 withdraws from yield vault, fails if there are not enough funds", async function () {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, cflAdmin, yieldVault, lp } = ret;

      expect(await yieldVault.totalAssets()).to.equal(0);
      expect(await cfl.totalAssets()).to.equal(0);

      await vaultDeposit(cfl, lp, _A(1000), currency);

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
    });

    it("should withdraw from yield vault when cash is insufficient", async function () {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, yieldVault, lp, cflAdmin } = ret;

      await vaultDeposit(cfl, lp, _A(1000), currency);

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

    it("should consider yieldVault.maxWithdraw for CFL's maxWithdraw", async function () {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, yieldVault, lp, cflAdmin } = ret;

      await vaultDeposit(cfl, lp, _A(1000), currency);

      await expect(() => cfl.connect(cflAdmin).depositIntoYieldVault(_A(800))).to.changeTokenBalances(
        currency,
        [cfl, yieldVault],
        [-_A(800), _A(800)]
      );

      expect(await cfl.totalAssets()).to.equal(_A(1000));
      expect(await yieldVault.totalAssets()).to.equal(_A(800));

      expect(await cfl.maxWithdraw(lp)).to.equal(_A(1000));
      expect(await cfl.maxRedeem(lp)).to.equal(_A(1000)); // 1:1 assets:shares

      await yieldVault.setOverride(OverrideOption.withdraw, _A(500));

      expect(await cfl.maxWithdraw(lp)).to.equal(_A(700));
      expect(await cfl.maxRedeem(lp)).to.equal(_A(700)); // 1:1 assets:shares

      await yieldVault.discreteEarning(_A(250));

      // Still the same because yieldVault.maxWithdraw didn't changed
      // Change in OZ 5.5.0 convertToAssets calculation used in MaxWithdraw, it truncates the result.
      expect(await cfl.maxWithdraw(lp)).to.closeTo(_A(700), 1n);
      expect(await cfl.maxRedeem(lp)).to.closeTo(_A(700 / 1.25), _A(0.01)); // 1 share = 1.25 assets

      await yieldVault.setOverride(OverrideOption.withdraw, await yieldVault.OVERRIDE_UNSET());

      expect(await cfl.maxRedeem(lp)).to.equal(_A(1000)); // Not it can redeem the 1000 shares
      expect(await cfl.maxWithdraw(lp)).to.closeTo(_A(1250), _A(0.01)); // But the withdrawable assets increased
    });

    it("should fail to withdraw when CFL has not enough funds due to debt", async function () {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp, cflAdmin, rm, pool } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));

      const { newPolicyCall } = await variant.createPolicyCall(ret, {});

      await vaultDeposit(cfl, lp, _A(1000), currency);

      await expect(variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall))
        .to.emit(pool, "NewPolicy")
        .withArgs(rm, captureAny.value);
      const newPolicy = captureAny.lastValue;

      await expect(cfl.connect(lp).withdraw(_A(1000), lp, lp)).to.be.revertedWithCustomError(
        cfl,
        "ERC4626ExceededMaxWithdraw"
      );

      const availableCash = await currency.balanceOf(cfl);
      const policyPremium = getPremium(newPolicy);
      expect(availableCash).to.equal(_A(1000) - policyPremium);

      expect(await cfl.maxWithdraw(lp)).to.equal(availableCash);
      await expect(cfl.connect(lp).withdraw(availableCash, lp, lp)).to.not.be.reverted;
    });

    it("forwardNewPolicy deinvest from yieldVault if cash balance is less than minLiquidity", async function () {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, yieldVault, lp, cflAdmin, rm, pool } = ret;

      // Deposit 300 and send 200 to the yieldVault
      await vaultDeposit(cfl, lp, _A(300), currency);
      await cfl.connect(cflAdmin).depositIntoYieldVault(_A(200));

      // Set minLiquidity = 250, so before any forwardNewPolicy it will try to have that amount in cash
      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(250));

      let { newPolicyCall } = await variant.createPolicyCall(ret, {
        payout: _A(1000),
        premium: _A(60),
        params: { moc: _W(1), ensuroPpFee: _W(0) }, // This will be ignored in the Trustful variants
      });

      await expect(variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall))
        .to.emit(pool, "NewPolicy")
        .withArgs(rm, captureAny.value)
        .to.emit(yieldVault, "Withdraw")
        .withArgs(cfl, cfl, cfl, captureAny.uint, anyUint);
      let newPolicy = captureAny.lastValue;

      expect(captureAny.lastUint).to.equal(_A(150)); // From 100 that already had in cash to 250

      const policyPremium2 = getPremium(newPolicy);
      expect(await currency.balanceOf(cfl)).to.equal(_A(250) - policyPremium2);

      // Then if I create another policy it will try to withdraw more, but since only 50 left in the yieldVault
      // if will withdraw only 50 withdraw failing
      newPolicyCall = (
        await variant.createPolicyCall(ret, {
          payout: _A(1000),
          premium: _A(60),
          params: { moc: _W(1), ensuroPpFee: _W(0) }, // This will be ignored in the Trustful variants
        })
      ).newPolicyCall;
      await expect(variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall))
        .to.emit(pool, "NewPolicy")
        .withArgs(rm, captureAny.value)
        .to.emit(yieldVault, "Withdraw")
        .withArgs(cfl, cfl, cfl, captureAny.uint, anyUint);
      newPolicy = captureAny.lastValue;

      expect(captureAny.lastUint).to.equal(_A(50)); // Just 50 remaining in the yieldVault
      expect(await currency.balanceOf(cfl)).to.equal(_A(300) - _A(60 * 2));
      expect(await currency.balanceOf(yieldVault)).to.equal(0);
    });

    it("Withdraw should deinvest from yield vault when cash is insufficient & fail when funds not enough due to debt", async function () {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, yieldVault, lp, cflAdmin, rm, pool } = ret;

      // Deposit 1000 and send 800 to the yieldVault
      await vaultDeposit(cfl, lp, _A(1000), currency);
      await cfl.connect(cflAdmin).depositIntoYieldVault(_A(800));

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));

      const { newPolicyCall } = await variant.createPolicyCall(ret, { payout: _A(1000) });

      await expect(variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall))
        .to.emit(pool, "NewPolicy")
        .withArgs(rm, captureAny.value);
      const newPolicy = captureAny.lastValue;

      await cfl.connect(lp).withdraw(_A(600), lp, lp);
      const policyPremium = getPremium(newPolicy);
      expect(await cfl.maxWithdraw(lp)).to.equal(_A(400) - policyPremium);

      expect(await yieldVault.totalAssets()).to.be.equal(_A(400) - policyPremium);

      await expect(cfl.connect(lp).withdraw(_A(400), lp, lp)).to.be.revertedWithCustomError(
        cfl,
        "ERC4626ExceededMaxWithdraw"
      );

      await expect(cfl.connect(lp).withdraw(await cfl.maxWithdraw(lp), lp, lp)).not.to.be.reverted;

      expect(await yieldVault.totalAssets()).to.be.equal(0);
      expect(await cfl.totalAssets()).to.be.equal(policyPremium);
    });

    it("Should restrict onXXX methods to be callable only by the PolicyPool", async function () {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, rm, cflAdmin } = ret;

      await expect(
        cfl.connect(cflAdmin).onERC721Received(rm, ZeroAddress, 1, ethers.toUtf8Bytes(""))
      ).to.be.revertedWithCustomError(cfl, "OnlyPolicyPool");

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

      await expect(
        cfl.connect(cflAdmin).onPolicyCancelled(rm, ZeroAddress, 1, _A(10), _A(5), _A(2))
      ).to.be.revertedWithCustomError(cfl, "OnlyPolicyPool");
    });

    it("Can forward a single new policy using batch method", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));

      const { newPolicyCall, chargedPremium } = await variant.createPolicyCall(ret, {});

      await variant.expectCustomError(
        ret,
        variant.callForwardMethod(ret, "forwardNewPolicyBatch", rm, [newPolicyCall]),
        cfl,
        "ERC20InsufficientBalance",
        [cfl, 0, captureAny.uint]
      );

      if (!variant.usesAA) expect(captureAny.lastUint).to.closeTo(chargedPremium, _A(0.1) * chargedPremium);

      await vaultDeposit(cfl, lp2, _A(100), currency);

      await expect(variant.callForwardMethod(ret, "forwardNewPolicyBatch", rm, [newPolicyCall]))
        .to.emit(pool, "NewPolicy")
        .withArgs(rm, captureAny.value);

      const newPolicy = captureAny.lastValue;
      const policyPremium = getPremium(newPolicy);
      expect(policyPremium).to.closeTo(chargedPremium, _A(0.1));

      expect(await pool.ownerOf(newPolicy.id)).to.equal(cfl);
    });

    it("Can forward multiple new policies using batch method", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));

      let policyCalls = [];
      let selectors = [];
      let totalChargedPremium = _A(0);

      for (let i = 0; i < 3; i++) {
        const { newPolicyCall, chargedPremium, selector } = await variant.createPolicyCall(ret, {});
        policyCalls.push(newPolicyCall);
        selectors.push(selector);
        totalChargedPremium += chargedPremium;
      }

      await variant.expectCustomError(
        ret,
        variant.callForwardMethod(ret, "forwardNewPolicyBatch", rm, policyCalls),
        cfl,
        "ERC20InsufficientBalance",
        [cfl, 0, captureAny.uint]
      );

      await vaultDeposit(cfl, lp2, _A(1000), currency);

      const slotSize = await cfl.SLOTSIZE_CALENDAR_MONTH();
      const now = new Date();
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth() + 1;
      const slotIndex = year * 100 + month;

      const capPolicies = Array.from({ length: 3 }, newCaptureAny);
      const [capValue, capDebtAfter, capTotalDebt] = Array.from({ length: 3 }, newCaptureAny);

      await expect(variant.callForwardMethod(ret, "forwardNewPolicyBatch", rm, policyCalls))
        .to.emit(pool, "NewPolicy")
        .withArgs(rm, capPolicies[0].value)
        .to.emit(pool, "NewPolicy")
        .withArgs(rm, capPolicies[1].value)
        .to.emit(pool, "NewPolicy")
        .withArgs(rm, capPolicies[2].value)
        .to.emit(cfl, "DebtChanged")
        .withArgs(rm, slotSize, slotIndex, capValue.uint, capDebtAfter.uint, capTotalDebt.uint);
      const totalPremium = capPolicies.reduce((acc, curr) => {
        const p = curr.lastValue;
        return acc + getPremium(p);
      }, 0n);
      expect(totalPremium).to.equal(capValue.lastUint);
      expect(totalPremium).to.equal(capDebtAfter.lastUint);
      expect(totalPremium).to.equal(capTotalDebt.lastUint);

      expect(await cfl.currentDebt()).to.be.closeTo(totalChargedPremium, _A(0.1));
      expect(await cfl.currentDebt()).to.be.equal(totalPremium);
      // A small difference is acceptable because of timing and duration dependency of minPremium
      expect(totalPremium).to.closeTo(totalChargedPremium, _A(0.01));

      // Send more policies
      policyCalls = [];
      selectors = [];
      totalChargedPremium = _A(0);

      for (let i = 0; i < 5; i++) {
        const { newPolicyCall, chargedPremium, selector } = await variant.createPolicyCall(ret, {});
        policyCalls.push(newPolicyCall);
        selectors.push(selector);
        totalChargedPremium += chargedPremium;
      }

      await expect(variant.callForwardMethod(ret, "forwardNewPolicyBatch", rm, policyCalls))
        .to.emit(cfl, "DebtChanged")
        .withArgs(rm, slotSize, slotIndex, capValue.uint, capDebtAfter.uint, capTotalDebt.uint);
      expect(await cfl.currentDebt()).to.be.closeTo(totalPremium + totalChargedPremium, _A(0.01));
      expect(capValue.lastUint).to.be.closeTo(totalChargedPremium, _A(0.01));
      expect(capDebtAfter.lastUint).to.be.closeTo(totalChargedPremium + totalPremium, _A(0.01));
      expect(capTotalDebt.lastUint).to.be.closeTo(totalChargedPremium + totalPremium, _A(0.01));
    });

    it("Can forward multiple new policies owned by someone else using batch method", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool, anon } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));

      let policyCalls = [];
      let selectors = [];
      let totalChargedPremium = _A(0);

      for (let i = 0; i < 3; i++) {
        const { newPolicyCall, chargedPremium, selector } = await variant.createPolicyCall(ret, {}, anon);
        policyCalls.push(newPolicyCall);
        selectors.push(selector);
        totalChargedPremium += chargedPremium;
      }

      await vaultDeposit(cfl, lp2, _A(1000), currency);

      const receipt = await (await variant.callForwardMethod(ret, "forwardNewPolicyBatch", rm, policyCalls)).wait();
      const newPolicyEvents = getTransactionEvent(pool.interface, receipt, "NewPolicy", false, getAddress(pool));
      const newPolicies = newPolicyEvents.map((evt) => evt.args.policy);
      const totalPremium = newPolicies.reduce((acc, curr) => acc + getPremium(curr), 0n);
      expect(totalPremium).to.closeTo(totalChargedPremium, _A("0.01"));

      // Check the policies are owned by anon
      for (const policy of newPolicies) {
        expect(await pool.ownerOf(policy.id)).to.equal(anon);
      }
    });

    it("Can forward heterogeneus new policies using batch method", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool, anon } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));
      await vaultDeposit(cfl, lp2, _A(1000), currency);

      let policyCalls = [];
      let selectors = [];
      let totalChargedPremium = _A(0);
      const inputs = [
        [ret, {}], // newPolicy onBehalfOf = cfl
        [ret, { method: variant.rmIsFull ? "newPolicy" : "newPolicyFull" }, anon], // newPolicyFull onBehalfOf = anon
        [ret, {}, lp2], // newPolicy onBehalfOf = lp2
      ];

      for (let i = 0; i < 3; i++) {
        const { newPolicyCall, chargedPremium, selector } = await variant.createPolicyCall(...inputs[i]);
        policyCalls.push(newPolicyCall);
        selectors.push(selector);
        totalChargedPremium += chargedPremium;
      }

      const receipt = await (await variant.callForwardMethod(ret, "forwardNewPolicyBatch", rm, policyCalls)).wait();
      const newPolicyEvents = getTransactionEvent(pool.interface, receipt, "NewPolicy", false, getAddress(pool));
      const newPolicies = newPolicyEvents.map((evt) => evt.args.policy);
      const totalPremium = newPolicies.reduce((acc, curr) => acc + getPremium(curr), 0n);
      expect(totalPremium).to.closeTo(totalChargedPremium, _A("0.01"));

      // Check the policies are owned by anon
      expect(await pool.ownerOf(newPolicies[0].id)).to.equal(cfl);
      expect(await pool.ownerOf(newPolicies[1].id)).to.equal(anon);
      expect(await pool.ownerOf(newPolicies[2].id)).to.equal(lp2);
    });

    it("Does nothing when calling forwardNewPolicyBatch with an empty array", async () => {
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

    it("Can resolve a single policy using batch method", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));
      await vaultDeposit(cfl, lp2, _A(100), currency);

      const { getPolicies, totalChargedPremium } = await forwardPolicies(variant, ret, 1);
      const [newPolicy] = await getPolicies();
      expect(await cfl.currentDebt()).to.closeTo(totalChargedPremium, _A("0.01"));

      const payout = _A(100);
      const resolveCall = rm.interface.encodeFunctionData("resolvePolicy", [newPolicy, payout]);

      const slotSize = await cfl.SLOTSIZE_CALENDAR_MONTH();
      const now = new Date();
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth() + 1;
      const slotIndex = year * 100 + month;

      await expect(variant.callForwardMethod(ret, "forwardResolvePolicyBatch", rm, [resolveCall]))
        .to.emit(pool, "PolicyResolved")
        .withArgs(rm, newPolicy.id, payout)
        .to.emit(cfl, "DebtChanged")
        .withArgs(rm, slotSize, slotIndex, captureAny.value, captureAny.value, captureAny.value);

      const finalDebt = await cfl.currentDebt();
      const policyPremium = getPremium(newPolicy);
      expect(finalDebt).to.be.equal(policyPremium - payout);
    });

    it("Can create, replace and resolve multiple policies using batch methods [!?rmIsFull]", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));

      await vaultDeposit(cfl, lp2, _A(1000), currency);

      const { callPromise, getPolicies, totalChargedPremium } = await forwardPolicies(variant, ret, 3);
      await expect(callPromise).to.emit(cfl, "DebtChanged");
      const newPolicies = await getPolicies();

      expect(await cfl.currentDebt()).to.be.closeTo(totalChargedPremium, _A(0.1));

      const replaceCalls = [];
      let totalChargedPremium2 = 0n;
      const replacementPayout = _A(200); // Two times the original payout
      for (let i = 0; i < 3; i++) {
        const { replacePolicyCall, chargedPremium } = await variant.replacePolicyCall(ret, newPolicies[i], {
          payout: replacementPayout,
        });
        replaceCalls.push(replacePolicyCall);
        totalChargedPremium2 += chargedPremium;
      }

      // Replace policies shouldn't be called with forwardResolvePolicyBatch, but instead forwardNewPolicyBatch
      await variant.expectCustomError(
        ret,
        variant.callForwardMethod(ret, "forwardResolvePolicyBatch", rm, replaceCalls),
        cfl,
        "BalanceDecreasedOnResolve",
        [captureAny.value]
      );
      if (!variant.usesAA) expect(captureAny.lastValue).to.closeTo(totalChargedPremium2, 10n);

      // Replace policies shouldn't be called with forwardResolvePolicyBatch, but instead forwardNewPolicyBatch
      const replaceTx = await variant.callForwardMethod(ret, "forwardNewPolicyBatch", rm, replaceCalls);
      const replaceReceipt = await replaceTx.wait();

      const replacePolicyEvents = getTransactionEvent(
        pool.interface,
        replaceReceipt,
        "PolicyReplaced",
        false,
        getAddress(pool)
      );

      const replacementPolicyEvents = getTransactionEvent(
        pool.interface,
        replaceReceipt,
        "NewPolicy",
        false,
        getAddress(pool)
      );

      const resolveCalls = [];
      const payout = _A(90);
      for (let i = 0; i < 3; i++) {
        let resolveCall;
        const policy = replacementPolicyEvents[i].args.policy;
        if (i !== 2) {
          resolveCall = rm.interface.encodeFunctionData("resolvePolicy", [policy, payout]);
        } else {
          resolveCall = rm.interface.encodeFunctionData("resolvePolicy", [policy, policy.payout]);
        }
        resolveCalls.push(resolveCall);
      }

      const initialDebt = await cfl.currentDebt();
      expect(initialDebt).to.closeTo(totalChargedPremium + totalChargedPremium2, 10n);
      const slotSize = await cfl.SLOTSIZE_CALENDAR_MONTH();
      const now = new Date();
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth() + 1;
      const slotIndex = year * 100 + month;

      await expect(variant.callForwardMethod(ret, "forwardResolvePolicyBatch", rm, resolveCalls))
        .to.emit(pool, "PolicyResolved")
        .withArgs(rm, replacePolicyEvents[0].args.newPolicyId, payout)
        .to.emit(pool, "PolicyResolved")
        .withArgs(rm, replacePolicyEvents[2].args.newPolicyId, replacementPayout)
        .to.emit(pool, "PolicyResolved")
        .withArgs(rm, replacePolicyEvents[1].args.newPolicyId, payout)
        .to.emit(cfl, "DebtChanged")
        .withArgs(rm, slotSize, slotIndex, captureAny.value, captureAny.value, captureAny.value);

      const finalDebt = await cfl.currentDebt();
      expect(finalDebt).to.be.closeTo(initialDebt - payout - replacementPayout - payout, 10n);
    });

    it("Can handle empty resolve batch without errors", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));

      await vaultDeposit(cfl, lp2, _A(100), currency);

      const initialDebt = await cfl.currentDebt();

      const resolveCalls = [];
      const resolveTx = await variant.callForwardMethod(ret, "forwardResolvePolicyBatch", rm, resolveCalls);

      await expect(resolveTx).to.not.emit(pool, "PolicyResolved");
      await expect(resolveTx).to.not.emit(cfl, "DebtChanged");

      const finalDebt = await cfl.currentDebt();
      expect(finalDebt).to.equal(initialDebt);
    });

    it("Can forward a resolve policy", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));
      await vaultDeposit(cfl, lp2, _A(100), currency);

      const { getPolicies } = await forwardPolicies(variant, ret, 1);
      const [newPolicy] = await getPolicies();

      const payout = _A(100);
      const resolveCall = rm.interface.encodeFunctionData("resolvePolicy", [newPolicy, payout]);

      const slotSize = await cfl.SLOTSIZE_CALENDAR_MONTH();
      const now = new Date();
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth() + 1;
      const slotIndex = year * 100 + month;

      await expect(variant.callForwardMethod(ret, "forwardResolvePolicy", rm, resolveCall))
        .to.emit(pool, "PolicyResolved")
        .withArgs(rm, newPolicy.id, payout)
        .to.emit(cfl, "DebtChanged")
        .withArgs(rm, slotSize, slotIndex, captureAny.value, captureAny.value, captureAny.value);

      const finalDebt = await cfl.currentDebt();
      const policyPremium = getPremium(newPolicy);
      expect(finalDebt).to.equal(policyPremium - payout);
    });

    it("Can forward a resolve policy with payout 0", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));
      await vaultDeposit(cfl, lp2, _A(100), currency);

      const [newPolicy] = await (await forwardPolicies(variant, ret, 1)).getPolicies();

      const payout = _A(0);
      const resolveCall = rm.interface.encodeFunctionData("resolvePolicy", [newPolicy, payout]);

      await expect(variant.callForwardMethod(ret, "forwardResolvePolicy", rm, resolveCall))
        .to.emit(pool, "PolicyResolved")
        .withArgs(rm, newPolicy.id, payout)
        .to.not.emit(cfl, "DebtChanged");

      const finalDebt = await cfl.currentDebt();
      const policyPremium = getPremium(newPolicy);
      expect(finalDebt).to.be.equal(policyPremium);
    });

    it("Can forward a resolve policy owned by someone else", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool, anon } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));

      const { newPolicyCall, chargedPremium } = await variant.createPolicyCall(ret, {}, anon);

      await vaultDeposit(cfl, lp2, _A(100), currency);

      await expect(variant.callForwardMethod(ret, "forwardNewPolicy", rm, newPolicyCall))
        .to.emit(pool, "NewPolicy")
        .withArgs(rm, captureAny.value);
      const newPolicy = captureAny.lastValue;

      const calculatedPremium = getPremium(newPolicy);
      expect(calculatedPremium).to.closeTo(chargedPremium, _A("0.0001"));

      expect(await pool.ownerOf(newPolicy.id)).to.equal(anon);

      const payout = _A(100);

      const resolveCall = rm.interface.encodeFunctionData("resolvePolicy", [newPolicy, payout]);

      const resolutionTx = await variant.callForwardMethod(ret, "forwardResolvePolicy", rm, resolveCall);

      await expect(resolutionTx).to.changeTokenBalance(currency, anon, _A(100));
    });

    it("Can't create new policies on deprecated targets, but it can resolve (unless suspended)", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));
      await vaultDeposit(cfl, lp2, _A(100), currency);

      const [newPolicy1, newPolicy2] = await (await forwardPolicies(variant, ret, 2)).getPolicies();

      await expect(cfl.connect(cflAdmin).setTargetStatus(rm, TargetStatus.inactive)).to.be.revertedWithCustomError(
        cfl,
        "CannotDeactivateTarget"
      );
      await expect(cfl.connect(cflAdmin).setTargetStatus(rm, TargetStatus.deprecated))
        .to.emit(cfl, "TargetStatusChanged")
        .withArgs(rm, TargetStatus.active, TargetStatus.deprecated);

      expect(await cfl.getTargetStatus(rm)).to.equal(TargetStatus.deprecated);

      const { callPromise } = await forwardPolicies(variant, ret, 1);
      await variant.expectCustomError(ret, callPromise, cfl, "TargetNotActive", [rm, TargetStatus.deprecated]);

      // Resolve the first policy
      const payout = _A(100);
      let resolveCall = rm.interface.encodeFunctionData("resolvePolicy", [newPolicy1, payout]);

      await expect(variant.callForwardMethod(ret, "forwardResolvePolicy", rm, resolveCall))
        .to.emit(pool, "PolicyResolved")
        .withArgs(rm, newPolicy1.id, payout)
        .to.emit(cfl, "DebtChanged");

      // Now suspend the target
      await expect(cfl.connect(cflAdmin).setTargetStatus(rm, TargetStatus.suspended))
        .to.emit(cfl, "TargetStatusChanged")
        .withArgs(rm, TargetStatus.deprecated, TargetStatus.suspended);

      resolveCall = rm.interface.encodeFunctionData("resolvePolicy", [newPolicy2, payout]);

      // resolve fails when suspended
      await variant.expectCustomError(
        ret,
        variant.callForwardMethod(ret, "forwardResolvePolicy", rm, resolveCall),
        cfl,
        "TargetNotActive",
        [rm, TargetStatus.suspended]
      );

      // resolve fails when suspended - Same with the batch method
      await variant.expectCustomError(
        ret,
        variant.callForwardMethod(ret, "forwardResolvePolicyBatch", rm, [resolveCall]),
        cfl,
        "TargetNotActive",
        [rm, TargetStatus.suspended]
      );

      await expect(rm.connect(cflAdmin).resolvePolicy([...newPolicy2], payout))
        .to.be.revertedWithCustomError(cfl, "TargetNotActive")
        .withArgs(rm, TargetStatus.suspended);

      const finalDebt = await cfl.currentDebt();
      const policyPremium1 = getPremium(newPolicy1);
      const policyPremium2 = getPremium(newPolicy2);
      expect(finalDebt).to.be.equal(policyPremium1 + policyPremium2 - payout);
    });

    it("It doesn't allow to create new policies if target limits exceeded", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, DAY, _A(100), _A(0));
      await vaultDeposit(cfl, lp2, _A(400), currency);

      // First policy goes well
      const [newPolicy] = await (await forwardPolicies(variant, ret, [{ premium: _A(80) }])).getPolicies();

      // Second policy fails because of target limit
      let { callPromise } = await forwardPolicies(variant, ret, [{ premium: _A(80) }]);
      await variant.expectCustomError(ret, callPromise, cfl, "DebtLimitExceeded", [_A(160), _A(100)]);

      // The limits are per time-slot - So I can create a 2nd policy if it's in a different slot
      await helpers.time.increase(DAY * 3);
      await (await forwardPolicies(variant, ret, [{ premium: _A(80) }])).getPolicies();

      // 2nd policy fails
      await variant.expectCustomError(ret, callPromise, cfl, "DebtLimitExceeded", [_A(160), _A(100)]);

      // But if a payout (even if it's of a policy of a different slot) reduces the debt, it goes through
      const payout = _A(60);
      const resolveCall = rm.interface.encodeFunctionData("resolvePolicy", [newPolicy, payout]);

      await expect(variant.callForwardMethod(ret, "forwardResolvePolicy", rm, resolveCall))
        .to.emit(pool, "PolicyResolved")
        .withArgs(rm, newPolicy.id, payout)
        .to.emit(cfl, "DebtChanged")
        .withArgs(rm, DAY, captureAny.uint, -payout, _A(20), anyUint);

      const slotIndex = captureAny.lastUint;

      expect(await cfl.getDebtForPeriod(rm, DAY, slotIndex)).to.equal(_A(20));

      await (await forwardPolicies(variant, ret, [{ premium: _A(80) }])).getPolicies();
      expect(await cfl.getDebtForPeriod(rm, DAY, slotIndex)).to.equal(_A(100));

      callPromise = (await forwardPolicies(variant, ret, [{ premium: _A(80) }])).callPromise;
      await variant.expectCustomError(ret, callPromise, cfl, "DebtLimitExceeded", [_A(180), _A(100)]);

      await expect(cfl.connect(cflAdmin).setTargetLimits(rm, _A(200), _A(0)))
        .to.emit(cfl, "TargetLimitsChanged")
        .withArgs(rm, _A(100), _A(200), _A(0), _A(0));

      await (await forwardPolicies(variant, ret, [{ premium: _A(80) }])).getPolicies();
      expect(await cfl.getDebtForPeriod(rm, DAY, slotIndex)).to.equal(_A(180));

      // Also the limits are reset if we change the slotSize
      await expect(cfl.connect(cflAdmin).setTargetSlotSize(rm, 0)).to.be.revertedWithCustomError(
        cfl,
        "InvalidSlotSize"
      );

      await expect(cfl.connect(cflAdmin).setTargetSlotSize(rm, WEEK))
        .to.emit(cfl, "TargetSlotSizeChanged")
        .withArgs(rm, DAY, WEEK);

      callPromise = (await forwardPolicies(variant, ret, [{ premium: _A(80) }])).callPromise;
      await expect(callPromise)
        .to.emit(cfl, "DebtChanged")
        .withArgs(rm, WEEK, captureAny.uint, _A(80), _A(80), anyUint);

      expect(captureAny.lastUint).not.be.equal(slotIndex);
      expect(await cfl.getDebtForPeriod(rm, DAY, slotIndex)).to.equal(_A(180));
      expect(await cfl.getDebtForPeriod(rm, WEEK, captureAny.lastUint)).to.equal(_A(80));
    });

    it("Can repay debt of previous slot", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool, bo } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));
      await vaultDeposit(cfl, lp2, _A(100), currency);

      const [newPolicy] = await (await forwardPolicies(variant, ret, [{ premium: _A(80) }])).getPolicies();

      const payout = _A(0);
      const resolveCall = rm.interface.encodeFunctionData("resolvePolicy", [newPolicy, payout]);

      const initialDebt = await cfl.currentDebt();
      await expect(variant.callForwardMethod(ret, "forwardResolvePolicy", rm, resolveCall))
        .to.emit(pool, "PolicyResolved")
        .withArgs(rm, newPolicy.id, payout)
        .to.not.emit(cfl, "DebtChanged");

      const slotSize = await cfl.SLOTSIZE_CALENDAR_MONTH();
      const now = new Date();
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth() + 1;
      const pastSlotIndex = year * 100 + month; // Intente utilizar el timeIncrease para pasar al siguiente slot pero me daba error otros tests, por qué?

      const partialRepay = _A(50);
      await currency.connect(bo).approve(cfl, _A(80));
      await expect(cfl.connect(bo).repayDebt(rm, slotSize, pastSlotIndex, partialRepay))
        .to.emit(cfl, "RepayDebt")
        .withArgs(rm, slotSize, pastSlotIndex, partialRepay, initialDebt - partialRepay, bo);
      const debtAfterPartial = await cfl.currentDebt();
      expect(debtAfterPartial).to.be.closeTo(initialDebt - partialRepay, _A(0.1));

      const excessRepay = _A(40);
      await currency.connect(bo).approve(cfl, excessRepay);
      await expect(cfl.connect(bo).repayDebt(rm, slotSize, pastSlotIndex, excessRepay)).to.be.revertedWithCustomError(
        cfl,
        "RepaymentExceedsLimit"
      );

      await expect(cfl.connect(bo).repayDebt(rm, slotSize, pastSlotIndex, debtAfterPartial))
        .to.emit(cfl, "RepayDebt")
        .withArgs(rm, slotSize, pastSlotIndex, debtAfterPartial, 0, bo);
      const finalDebt = await cfl.currentDebt();
      expect(finalDebt).to.equal(0);
    });

    it("Can cashout payouts of previous slot", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool, bo } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));
      await vaultDeposit(cfl, lp2, _A(100), currency);

      const [newPolicy] = await (await forwardPolicies(variant, ret, [{ premium: _A(70) }])).getPolicies();
      const payout = _A(100);
      const resolveCall = rm.interface.encodeFunctionData("resolvePolicy", [newPolicy, payout]);

      await expect(variant.callForwardMethod(ret, "forwardResolvePolicy", rm, resolveCall))
        .to.emit(pool, "PolicyResolved")
        .withArgs(rm, newPolicy.id, payout)
        .to.emit(cfl, "DebtChanged");
      const initialDebt = await cfl.currentDebt();
      const slotSize = await cfl.SLOTSIZE_CALENDAR_MONTH();
      const now = new Date();
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth() + 1;
      const pastSlotIndex = year * 100 + month; // Al igual que en repayDebt me da error si utilizo timeIncrease

      const partialCashoutPayouts = _A(20);
      await expect(cfl.connect(bo).cashOutPayouts(rm, slotSize, pastSlotIndex, partialCashoutPayouts, bo))
        .to.emit(cfl, "CashOutPayout")
        .withArgs(rm, slotSize, pastSlotIndex, partialCashoutPayouts, initialDebt + partialCashoutPayouts, bo);
      const debtAfterPartial = await cfl.currentDebt();
      expect(debtAfterPartial).to.be.closeTo(initialDebt + partialCashoutPayouts, _A(0.1));

      await expect(
        cfl.connect(bo).cashOutPayouts(rm, slotSize, pastSlotIndex, _A(20), bo)
      ).to.be.revertedWithCustomError(cfl, "CashOutExceedsLimit");

      await expect(cfl.connect(bo).cashOutPayouts(rm, slotSize, pastSlotIndex, _A(10), bo))
        .to.emit(cfl, "CashOutPayout")
        .withArgs(rm, slotSize, pastSlotIndex, _A(10), 0, bo);
      const finalDebt = await cfl.currentDebt();
      expect(finalDebt).to.equal(0);
    });

    it("It doesn't mix debt of different slots", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool, bo, yieldVault } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, DAY, _A(1000), _A(0));
      await vaultDeposit(cfl, lp2, _A(100), currency);

      const premium = _A(70);
      const { callPromise, getPolicies } = await forwardPolicies(variant, ret, [{ premium }]);
      await expect(callPromise)
        .to.emit(cfl, "DebtChanged")
        .withArgs(rm, DAY, captureAny.uint, premium, premium, premium);
      const [newPolicy] = await getPolicies();
      const slotIndex1 = captureAny.lastUint;

      await helpers.time.increase(DAY * 3);
      const payout = _A(100);
      const resolveCall = rm.interface.encodeFunctionData("resolvePolicy", [newPolicy, payout]);

      await expect(variant.callForwardMethod(ret, "forwardResolvePolicy", rm, resolveCall))
        .to.emit(pool, "PolicyResolved")
        .withArgs(rm, newPolicy.id, payout)
        .to.emit(cfl, "DebtChanged")
        .withArgs(rm, DAY, captureAny.uint, -payout, -payout, premium - payout);
      const slotIndex2 = captureAny.lastUint;

      // Slots are different since we increased two days
      expect(slotIndex1).not.to.be.equal(slotIndex2);
      expect(slotIndex1 + 3n).to.be.closeTo(slotIndex2, 1n); // 1 slot tolerance in case close to end of slot

      expect(await cfl.totalAssets()).to.equal(_A(100));
      expect(await cfl.currentDebt()).to.equal(premium - payout);

      expect(await cfl.getDebtForPeriod(rm, DAY, slotIndex1)).to.equal(premium);
      expect(await cfl.getDebtForPeriod(rm, DAY, slotIndex2)).to.equal(-payout);

      await expect(() => cfl.connect(lp2).redeem(_A(90), lp2, lp2)).to.changeTokenBalances(
        currency,
        [cfl, lp2],
        [-_A(90), _A(90)]
      );
      expect(await cfl.cashWithdrawable()).to.equal(_A(10) - premium + payout); // 40

      // Check cashOutPayouts don't work on the initial slot because there debt is positive
      await expect(cfl.connect(bo).cashOutPayouts(rm, DAY, slotIndex1, _A(1), bo))
        .to.be.revertedWithCustomError(cfl, "CashOutExceedsLimit")
        .withArgs(_A(1), premium + _A(1));

      // Check cashOutPayouts doesn't work on the second slot because of lack of cash
      await expect(cfl.connect(bo).cashOutPayouts(rm, DAY, slotIndex2, payout, bo)).to.be.revertedWithCustomError(
        cfl,
        "NotEnoughCash"
      );

      // Transfer all the funds to the yield vault
      await expect(() => cfl.connect(cflAdmin).depositIntoYieldVault(MaxUint256)).to.changeTokenBalances(
        currency,
        [cfl, yieldVault],
        [-_A(40), _A(40)]
      );

      await yieldVault.setOverride(OverrideOption.withdraw, _A(5));
      expect(await cfl.maxWithdraw(lp2)).to.equal(_A(5));
      // Withdrawal fails because it can't withdraw more than 5 from the yieldVault
      await expect(cfl.connect(lp2).withdraw(_A(10), lp2, lp2)).to.be.revertedWithCustomError(
        cfl,
        "ERC4626ExceededMaxWithdraw"
      );

      // It can also fail because not all the funds are withdrawable
      await expect(cfl.connect(bo).cashOutPayouts(rm, DAY, slotIndex2, _A(40), bo)).to.be.revertedWithCustomError(
        cfl,
        "NotEnoughCash"
      );

      await yieldVault.setOverride(OverrideOption.withdraw, await yieldVault.OVERRIDE_UNSET());

      // Withdrawal of 40 now works
      await expect(cfl.connect(bo).cashOutPayouts(rm, DAY, slotIndex2, _A(40), bo))
        .to.emit(cfl, "CashOutPayout")
        .withArgs(rm, DAY, slotIndex2, _A(40), -_A(60), bo)
        .to.emit(cfl, "DebtChanged")
        .withArgs(rm, DAY, slotIndex2, _A(40), -_A(60), premium - payout + _A(40))
        .to.emit(yieldVault, "Withdraw") // Withdrawal from the yield vault
        .withArgs(cfl, cfl, cfl, _A(40), _A(40));

      // Repayment of the slotIndex1 debt
      await expect(cfl.connect(bo).repayDebt(rm, DAY, slotIndex2, _A(1)))
        .to.be.revertedWithCustomError(cfl, "RepaymentExceedsLimit")
        .withArgs(_A(1), -payout + _A(40) - _A(1));

      await currency.connect(bo).approve(cfl, premium);
      await expect(cfl.connect(bo).repayDebt(rm, DAY, slotIndex1, premium))
        .to.emit(cfl, "RepayDebt")
        .withArgs(rm, DAY, slotIndex1, premium, _A(0), bo)
        .to.emit(cfl, "DebtChanged")
        .withArgs(rm, DAY, slotIndex1, -premium, 0, -payout + _A(40));
      // Check allowance has been spent, because bo (the _msgSender) paid
      expect(await currency.allowance(cfl, bo)).to.equal(0);

      // Now the cashOutPayouts of the remaining debt with the customer works
      await expect(cfl.connect(bo).cashOutPayouts(rm, DAY, slotIndex2, payout - _A(40), bo))
        .to.emit(cfl, "CashOutPayout")
        .withArgs(rm, DAY, slotIndex2, payout - _A(40), 0, bo)
        .to.emit(cfl, "DebtChanged")
        .withArgs(rm, DAY, slotIndex2, payout - _A(40), 0, 0);

      // Debt is 0 and everyone is happy!
      expect(await cfl.currentDebt()).to.equal(0);
    });

    it("It doesn't mix debt of different targets", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool, acMgr, admin } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, DAY, _A(1000), _A(0));

      const rm2 = await addRMToPool(ret);
      await pool.connect(admin).setExposureLimit(rm2, 2n ** 128n - 1n);
      await makeCFLForwardingPublic(cfl, rm2, acMgr.connect(admin));
      await vaultDeposit(cfl, lp2, _A(200), currency);

      const premium = _A(70);
      let { callPromise } = await forwardPolicies(variant, ret, [{ premium }, { premium }]);
      await expect(callPromise)
        .to.emit(cfl, "DebtChanged")
        .withArgs(rm, DAY, captureAny.uint, premium * 2n, premium * 2n, premium * 2n);
      const slotIndex1 = captureAny.lastUint;

      const premium2 = _A(50);
      callPromise = (await forwardPolicies(variant, { ...ret, rm: rm2 }, [{ premium: premium2 }])).callPromise;

      await variant.expectCustomError(ret, callPromise, cfl, "TargetNotFound", [rm2]);

      await cfl.connect(cflAdmin).addTarget(rm2, WEEK, _A(1000), _A(0));
      callPromise = (await forwardPolicies(variant, { ...ret, rm: rm2 }, [{ premium: premium2 }])).callPromise;

      await expect(callPromise)
        .to.emit(pool, "NewPolicy")
        .withArgs(rm2, captureAny.value)
        .to.emit(cfl, "DebtChanged")
        .withArgs(rm2, WEEK, captureAny.uint, premium2, premium2, premium * 2n + premium2);

      const slotIndex2 = captureAny.lastUint;
      const newPolicyRM2 = captureAny.lastValue;

      expect(slotIndex2).not.to.be.equal(slotIndex1);

      expect(await cfl.currentDebt()).to.equal(premium * 2n + premium2);
      expect(await cfl.getDebtForPeriod(rm, DAY, slotIndex1)).to.equal(premium * 2n);
      expect(await cfl.getDebtForPeriod(rm2, DAY, slotIndex1)).to.equal(0);
      expect(await cfl.getDebtForPeriod(rm2, WEEK, slotIndex2)).to.equal(premium2);
      expect(await cfl.getDebtForPeriod(rm, WEEK, slotIndex2)).to.equal(0);

      const payout = _A(100);
      const resolveCall = rm2.interface.encodeFunctionData("resolvePolicy", [newPolicyRM2, payout]);

      await expect(variant.callForwardMethod(ret, "forwardResolvePolicy", rm2, resolveCall))
        .to.emit(pool, "PolicyResolved")
        .withArgs(rm2, newPolicyRM2.id, payout)
        .to.emit(cfl, "DebtChanged")
        .withArgs(rm2, WEEK, slotIndex2, -payout, premium2 - payout, 2n * premium + premium2 - payout);

      expect(await cfl.currentDebt()).to.equal(premium * 2n + premium2 - payout);
      expect(await cfl.getDebtForPeriod(rm, DAY, slotIndex1)).to.equal(premium * 2n);
      expect(await cfl.getDebtForPeriod(rm2, DAY, slotIndex1)).to.equal(0);
      expect(await cfl.getDebtForPeriod(rm2, WEEK, slotIndex2)).to.equal(premium2 - payout);
      expect(await cfl.getDebtForPeriod(rm, WEEK, slotIndex2)).to.equal(0);
    });

    it("Can't add a target twice", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, rm, cflAdmin } = ret;

      await expect(cfl.connect(cflAdmin).addTarget(rm, 0, _A(1000), _A(0))).to.be.revertedWithCustomError(
        cfl,
        "InvalidSlotSize"
      );
      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));
      await expect(cfl.connect(cflAdmin).addTarget(rm, DAY, _A(1000), _A(0))).to.be.revertedWithCustomError(
        cfl,
        "TargetAlreadyExists"
      );
    });

    it("Can forward a cancel policy", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, currency, lp2, rm, cflAdmin, pool } = ret;

      await cfl.connect(cflAdmin).addTarget(rm, await cfl.SLOTSIZE_CALENDAR_MONTH(), _A(1000), _A(0));
      await vaultDeposit(cfl, lp2, _A(100), currency);

      // Create a policy first to have initial debt
      const { getPolicies } = await forwardPolicies(variant, ret, 1);
      const [newPolicy] = await getPolicies();

      const policyPremium = getPremium(newPolicy);
      const initialDebt = await cfl.currentDebt();
      expect(initialDebt).to.equal(policyPremium);

      const purePremiumRefund = newPolicy.purePremium;
      const jrCocRefund = newPolicy.jrCoc;
      const srCocRefund = newPolicy.srCoc;
      const totalRefund = purePremiumRefund + jrCocRefund + srCocRefund;

      const cancelInputData = makeFTUWCancelInputData({
        policyToCancel: newPolicy,
        purePremiumRefund,
        jrCocRefund,
        srCocRefund,
      });
      const cancelCall = rm.interface.encodeFunctionData("cancelPolicy", [cancelInputData]);

      const slotSize = await cfl.SLOTSIZE_CALENDAR_MONTH();
      const now = new Date();
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth() + 1;
      const slotIndex = year * 100 + month;

      await expect(variant.callForwardMethod(ret, "forwardResolvePolicy", rm, cancelCall))
        .to.emit(pool, "PolicyCancelled")
        .withArgs(rm, newPolicy.id, captureAny.value, captureAny.value, captureAny.value)
        .to.emit(cfl, "DebtChanged")
        .withArgs(rm, slotSize, slotIndex, -totalRefund, initialDebt - totalRefund, initialDebt - totalRefund);

      const finalDebt = await cfl.currentDebt();
      expect(finalDebt).to.equal(initialDebt - totalRefund);
      expect(finalDebt).to.equal(newPolicy.ensuroCommission + newPolicy.partnerCommission);
    });

    it("Can upgrade the CFL ", async () => {
      const ret = await helpers.loadFixture(variant.fixture);
      const { cfl, CashFlowLender, cflAdmin, pool, trustedForwarder } = ret;
      const newCFLImpl = await CashFlowLender.deploy(trustedForwarder, pool);
      await expect(cfl.connect(cflAdmin).upgradeToAndCall(newCFLImpl, ethers.toUtf8Bytes("")))
        .to.emit(cfl, "Upgraded")
        .withArgs(newCFLImpl);
    });
  });
});
