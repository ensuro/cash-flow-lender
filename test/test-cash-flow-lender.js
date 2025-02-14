const { expect } = require("chai");
const { amountFunction, tagit, makeAllViewsPublic } = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const {
  deployPool,
  // deployPremiumsAccount,
  // addRiskModule,
  // addEToken,
} = require("../js/binary-ensuro-test-utils");

const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { deploy: ozUpgradesDeploy } = require("@openzeppelin/hardhat-upgrades/dist/utils");

const { ethers } = hre;
const { ZeroAddress } = ethers;

const CURRENCY_DECIMALS = 6;
const _A = amountFunction(CURRENCY_DECIMALS);
const INITIAL = 10000;
const NAME = "Cash Flow Lender";
const SYMB = "CFL";

async function setUp() {
  const [, lp, lp2, anon, guardian, admin] = await ethers.getSigners();
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

  const TestERC4626 = await ethers.getContractFactory("TestERC4626");
  const CashFlowLender = await ethers.getContractFactory("CashFlowLender");
  const yieldVault = await TestERC4626.deploy("Yield Vault", "YIELD", currency);

  return {
    currency,
    adminAddr,
    lp,
    lp2,
    anon,
    guardian,
    admin,
    AccessManagedProxy,
    AccessManager,
    acMgr,
    CashFlowLender,
    TestERC4626,
    yieldVault,
    pool,
  };
}

const variants = [
  {
    name: "CashFlowLender",
    tagit: tagit,
    fixture: async () => {
      const ret = await setUp();
      const { admin, CashFlowLender, yieldVault, acMgr, pool, AccessManagedProxy } = ret;
      const vault = await hre.upgrades.deployProxy(
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
      await makeAllViewsPublic(acMgr.connect(admin), vault);
      return {
        ...ret,
      };
    },
  },
];

variants.forEach((variant) => {
  describe(`${variant.name} contract tests`, function () {
    variant.tagit("Checks vault constructs with disabled initializer ", async () => {
      const { CashFlowLender, pool, yieldVault } = await helpers.loadFixture(variant.fixture);
      const newCFL = await CashFlowLender.deploy(ZeroAddress, pool);
      await expect(newCFL.deploymentTransaction()).to.emit(newCFL, "Initialized");
      await expect(newCFL.initialize(NAME, SYMB, yieldVault)).to.be.revertedWithCustomError(
        CashFlowLender,
        "InvalidInitialization"
      );
    });
  });
});
