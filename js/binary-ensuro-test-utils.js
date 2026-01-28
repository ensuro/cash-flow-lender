const hre = require("hardhat");
const { ethers } = hre;
const { _W, AM_ROLES } = require("@ensuro/utils/js/utils");
const { deployProxy } = require("@ensuro/utils/js/test-utils");
const { attachAsAMP } = require("@ensuro/access-managed-proxy/js/deployProxy");

const { ZeroAddress } = ethers;

async function createRiskModule(
  pool,
  premiumsAccount,
  contractFactory,
  { wallet, underwriterFactory, underwriter, extraArgs, extraConstructorArgs }
) {
  extraArgs = extraArgs || [];
  extraConstructorArgs = extraConstructorArgs || [];

  const poolAddr = await ethers.resolveAddress(pool);
  const paAddr = await ethers.resolveAddress(premiumsAccount);
  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");

  let underwriterAddr;
  if (underwriter) {
    // Reuse an existing underwriter instance
    underwriterAddr = await ethers.resolveAddress(underwriter);
  } else {
    // Deploy a new underwriter of the specified type (default: FullTrustedUW)
    const UnderwriterFactory = await ethers.getContractFactory(underwriterFactory || "@ensuro/core/FullTrustedUW");
    const deployedUnderwriter = await UnderwriterFactory.deploy();
    await deployedUnderwriter.waitForDeployment();
    underwriterAddr = await ethers.resolveAddress(deployedUnderwriter);
  }

  const defaultWallet = wallet || "0xdD2FD4581271e230360230F9337D5c0430Bf44C0";

  const initArgs = [underwriterAddr, defaultWallet, ...extraArgs];

  const rm = await deployProxy(ERC1967Proxy, contractFactory, [poolAddr, paAddr, ...extraConstructorArgs], initArgs);

  return rm;
}

async function addRiskModule(
  pool,
  premiumsAccount,
  contractFactory,
  { wallet, underwriterFactory, underwriter, extraArgs, extraConstructorArgs }
) {
  const rm = await createRiskModule(pool, premiumsAccount, contractFactory, {
    wallet,
    underwriterFactory,
    underwriter,
    extraArgs,
    extraConstructorArgs,
  });

  await pool.addComponent(rm, 2);
  return rm;
}

async function createEToken(
  pool,
  { etkName, etkSymbol, maxUtilizationRate, internalLoanInterestRate, extraArgs, extraConstructorArgs }
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
      _W(internalLoanInterestRate) || _W("0.05"),
      ...extraArgs,
    ]
  );

  return etk;
}

async function addEToken(
  pool,
  { etkName, etkSymbol, maxUtilizationRate, internalLoanInterestRate, extraArgs, extraConstructorArgs }
) {
  const etk = await createEToken(pool, {
    etkName,
    etkSymbol,
    maxUtilizationRate,
    internalLoanInterestRate,
    extraArgs,
    extraConstructorArgs,
  });
  await pool.addComponent(etk, 1);
  return etk;
}

const randomAddress = "0x89cDb70Fee571251a66E34caa1673cE40f7549Dc";

/**
 * Deploys the PolicyPool contract
 *
 * options:
 * - .currency: mandatory, the address of the currency used in the PolicyPool
 * - .nftName: default "Policy NFT"
 * - .nftSymbol: default "EPOL"
 * - .treasuryAddress: default randomAddress
 */
async function deployPool(options) {
  const PolicyPool = await ethers.getContractFactory("@ensuro/core/PolicyPool");
  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");

  const currencyAddr = await ethers.resolveAddress(options.currency);
  const policyPool = await deployProxy(
    ERC1967Proxy,
    PolicyPool,
    [currencyAddr],
    [
      options.nftName === undefined ? "Policy NFT" : options.nftName,
      options.nftSymbol === undefined ? "EPOL" : options.nftSymbol,
      options.treasuryAddress || randomAddress,
    ]
  );

  await policyPool.waitForDeployment();

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

async function makeAllPublic(contract, accessManager) {
  const skipSelectors = await (await attachAsAMP(contract)).PASS_THRU_METHODS();
  const selectors = contract.interface.fragments
    .filter((fragment) => fragment.type === "function" && skipSelectors.indexOf(fragment.selector) < 0)
    .map((fragment) => fragment.selector);
  await accessManager.setTargetFunctionRole(contract, selectors, AM_ROLES.PUBLIC_ROLE);
}

async function makeCFLForwardingPublic(cfl, rm, accessManager) {
  const rmSelectors = ["newPolicy", "newPolicyFull", "resolvePolicy", "replacePolicy", "cancelPolicy"]
    .map((method) => rm.interface.getFunction(method)?.selector)
    .filter((selector) => selector !== undefined);

  const ownPolicySelector = await cfl.OWN_POLICY_SELECTOR();
  rmSelectors.push(ownPolicySelector);

  const fakeSelectors = await Promise.all(rmSelectors.map((selector) => cfl.makeFakeSelector(rm, selector)));

  await accessManager.setTargetFunctionRole(cfl, fakeSelectors, AM_ROLES.PUBLIC_ROLE);
}

module.exports = {
  addEToken,
  addRiskModule,
  createEToken,
  createRiskModule,
  deployPool,
  deployProxy,
  deployPremiumsAccount,
  makeAllPublic,
  makeCFLForwardingPublic,
};
