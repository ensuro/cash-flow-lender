require("@openzeppelin/hardhat-upgrades");
require("hardhat-dependency-compiler");
require("hardhat-contract-sizer");
require("@nomicfoundation/hardhat-toolbox");
require("hardhat-exposed");

const hretry = require("@ensuro/utils/js/hardhat-retry");

hretry.installWrapper();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.30",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "prague",
    },
  },
  networks: {
    hardhat: {
      // Adding this setting just to unlock error when using hardhat-exposed for tests.
      // But anyway, in Polygon the limit is 32KB, not 24KB - https://governance.polygon.technology/proposals/PIP-30/
      allowUnlimitedContractSize: true,
    },
  },
  contractSizer: {
    alphaSort: true,
    runOnCompile: false,
    disambiguatePaths: false,
  },
  dependencyCompiler: {
    paths: [
      "@ensuro/utils/contracts/TestCurrency.sol",
      "@ensuro/utils/contracts/TestERC4626.sol",
      "@ensuro/account-abstraction/contracts/ERC2771ForwarderAccount.sol",
      "@openzeppelin/contracts/access/manager/AccessManager.sol",
      "@account-abstraction/contracts/core/EntryPoint.sol",
      "@ensuro/core/contracts/interfaces/IPolicyHolder.sol",
      "@ensuro/core/contracts/PolicyPool.sol",
      "@ensuro/core/contracts/EToken.sol",
      "@ensuro/core/contracts/PremiumsAccount.sol",
      "@ensuro/core/contracts/RiskModule.sol",
      "@ensuro/core/contracts/underwriters/FullTrustedUW.sol",
      "@ensuro/core/contracts/underwriters/FullSignedUW.sol",
    ],
  },
};
