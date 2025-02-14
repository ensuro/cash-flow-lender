const hre = require("hardhat");
const { ethers } = hre;
const { grantRole } = require("@ensuro/utils/js/utils");
const { deployProxy } = require("@ensuro/utils/js/test-utils");

const randomAddress = "0x0000000071727de22e5e9d8baf0edac6f37da032";

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

module.exports = {
  //  addEToken,
  //  addRiskModule,
  //  createEToken,
  //  createRiskModule,
  deployPool,
  deployProxy,
  //  deployPremiumsAccount,
  //  makePolicy,
};
