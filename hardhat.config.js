require("@openzeppelin/hardhat-upgrades");
require("hardhat-dependency-compiler");
require("hardhat-contract-sizer");
require("@nomicfoundation/hardhat-toolbox");
require("hardhat-exposed");

const hretry = require("@ensuro/utils/js/hardhat-retry");
const verifiableBinaries = require("@ensuro/utils/js/verifiableBinaries");

hretry.installWrapper();
verifiableBinaries.wrapEthersFunctions();
verifiableBinaries.addTasks();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
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
    ],
  },
  verifiableBinaries: {
    path: "./verifiable-binaries",
    packages: [
      {
        package: "@ensuro/core",
        version: "2.9.1",
        type: "npm",
        artifactsConfig: {
          onlyFQ: "package",
        },
      },
    ],
  },
};
