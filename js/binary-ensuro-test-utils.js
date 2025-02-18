const hre = require("hardhat");
const { ethers } = hre;
const { _W, grantRole } = require("@ensuro/utils/js/utils");
const { deployProxy } = require("@ensuro/utils/js/test-utils");
const { RiskModuleParameter } = require("@ensuro/core/js/enums");

const { ZeroAddress } = ethers;

async function createRiskModule(
  pool,
  premiumsAccount,
  contractFactory,
  {
    rmName,
    collRatio,
    srRoc,
    ensuroPPFee,
    maxPayoutPerPolicy,
    exposureLimit,
    moc,
    wallet,
    extraArgs,
    extraConstructorArgs,
  }
) {
  extraArgs = extraArgs || [];
  extraConstructorArgs = extraConstructorArgs || [];
  const _A = pool._A || _W;
  maxPayoutPerPolicy = maxPayoutPerPolicy !== undefined ? _A(maxPayoutPerPolicy) : _A(1000);
  exposureLimit = exposureLimit !== undefined ? _A(exposureLimit) : _A(1000000);

  const poolAddr = await ethers.resolveAddress(pool);
  const paAddr = await ethers.resolveAddress(premiumsAccount);
  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const rm = await deployProxy(
    ERC1967Proxy,
    contractFactory,
    [poolAddr, paAddr, ...extraConstructorArgs],
    [
      rmName || "RiskModule",
      _W(collRatio) || _W(1),
      _W(ensuroPPFee) || _W(0),
      _W(srRoc) || _W("0.1"),
      maxPayoutPerPolicy,
      exposureLimit,
      wallet || "0xdD2FD4581271e230360230F9337D5c0430Bf44C0", // Random address
      ...extraArgs,
    ]
  );

  if (moc !== undefined && moc != 1.0) {
    moc = _W(moc);
    await rm.setParam(RiskModuleParameter.moc, moc);
  }
  return rm;
}

async function addRiskModule(
  pool,
  premiumsAccount,
  contractFactory,
  {
    rmName,
    collRatio,
    srRoc,
    ensuroPPFee,
    maxPayoutPerPolicy,
    exposureLimit,
    moc,
    wallet,
    extraArgs,
    extraConstructorArgs,
  }
) {
  const rm = await createRiskModule(pool, premiumsAccount, contractFactory, {
    rmName,
    collRatio,
    srRoc,
    ensuroPPFee,
    maxPayoutPerPolicy,
    exposureLimit,
    moc,
    wallet,
    extraArgs,
    extraConstructorArgs,
  });

  await pool.addComponent(rm, 2);
  return rm;
}

async function createEToken(
  pool,
  { etkName, etkSymbol, maxUtilizationRate, poolLoanInterestRate, extraArgs, extraConstructorArgs }
) {
  const EToken = await ethers.getContractFactory("@ensuro/core/EToken");
  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
  extraArgs = extraArgs || [];
  extraConstructorArgs = extraConstructorArgs || [];
  const poolAddr = await ethers.resolveAddress(pool);
  const etk = await deployProxy(
    ERC1967Proxy,
    EToken,
    [poolAddr, ...extraConstructorArgs],
    [
      etkName === undefined ? "EToken" : etkName,
      etkSymbol === undefined ? "eUSD1YEAR" : etkSymbol,
      _W(maxUtilizationRate) || _W(1),
      _W(poolLoanInterestRate) || _W("0.05"),
      ...extraArgs,
    ]
  );

  return etk;
}

async function addEToken(
  pool,
  { etkName, etkSymbol, maxUtilizationRate, poolLoanInterestRate, extraArgs, extraConstructorArgs }
) {
  const etk = await createEToken(pool, {
    etkName,
    etkSymbol,
    maxUtilizationRate,
    poolLoanInterestRate,
    extraArgs,
    extraConstructorArgs,
  });
  await pool.addComponent(etk, 1);
  return etk;
}

const randomAddress = "0x89cDb70Fee571251a66E34caa1673cE40f7549Dc";

/**
 * Deploys the PolicyPool contract and AccessManager
 *
 * By default deployes de PolicyPool and AccessManager and grants LEVEL 1, 2, 3 permissions
 *
 * options:
 * - .currency: mandatory, the address of the currency used in the PolicyPool
 * - .access: if specified, doesn't create an AccessManager, uses this address.toLowerCase
 * - .nftName: default "Policy NFT"
 * - .nftSymbol: default "EPOL"
 * - .treasuryAddress: default randomAddress
 * - .grantRoles: default []. List of additional roles to grant
 * - .dontGrantL123Roles: if specified, doesn't grants LEVEL1, 2 and 3 roles.
 */
async function deployPool(options) {
  const PolicyPool = await ethers.getContractFactory("@ensuro/core/PolicyPool");
  const AccessManager = await ethers.getContractFactory("@ensuro/core/AccessManager");
  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");

  let accessManager;

  if (options.access === undefined) {
    // Deploy AccessManager
    accessManager = await deployProxy(ERC1967Proxy, AccessManager, [], []);
  } else {
    accessManager = await ethers.getContractAt("AccessManager", options.access);
  }

  const currencyAddr = await ethers.resolveAddress(options.currency);
  const amAddr = await ethers.resolveAddress(accessManager);
  const policyPool = await deployProxy(
    ERC1967Proxy,
    PolicyPool,
    [amAddr, currencyAddr],
    [
      options.nftName === undefined ? "Policy NFT" : options.nftName,
      options.nftSymbol === undefined ? "EPOL" : options.nftSymbol,
      options.treasuryAddress || randomAddress,
    ]
  );

  await policyPool.waitForDeployment();

  for (const role of options.grantRoles || []) {
    await grantRole(hre, accessManager, role);
  }

  if (options.dontGrantL123Roles === undefined) {
    await grantRole(hre, accessManager, "LEVEL1_ROLE");
    await grantRole(hre, accessManager, "LEVEL2_ROLE");
  }

  return policyPool;
}

async function deployPremiumsAccount(pool, options, addToPool = true) {
  const PremiumsAccount = await ethers.getContractFactory("@ensuro/core/PremiumsAccount");
  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const poolAddr = await ethers.resolveAddress(pool);
  const jrEtkAddr = options.jrEtk ? await ethers.resolveAddress(options.jrEtk) : ZeroAddress;
  const srEtkAddr = options.srEtk ? await ethers.resolveAddress(options.srEtk) : ZeroAddress;
  const premiumsAccount = await deployProxy(ERC1967Proxy, PremiumsAccount, [poolAddr, jrEtkAddr, srEtkAddr], []);

  if (addToPool) await pool.addComponent(premiumsAccount, 3);

  return premiumsAccount;
}

module.exports = {
  addEToken,
  addRiskModule,
  createEToken,
  createRiskModule,
  deployPool,
  deployProxy,
  deployPremiumsAccount,
};
