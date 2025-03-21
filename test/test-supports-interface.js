const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { ZeroAddress } = ethers;

describe("Supports interface implementation", function () {
  // eslint-disable-next-line multiline-comment-style
  /* According to ERC165Checker.sol:
        // Any contract that implements ERC165 must explicitly indicate support of
        // InterfaceId_ERC165 and explicitly indicate non-support of InterfaceId_Invalid=0xffffffff
  */
  const invalidInterfaceId = "0xffffffff";

  it("Checks CashFlowLender supported interfaces", async () => {
    const interfaceIds = {
      IERC165: "0x01ffc9a7",
      IERC20: "0x36372b07",
      IERC20Metadata: "0xa219a025",
      IERC721: "0x80ac58cd",
      IPolicyHolder: "0x3ece0a89",
      IPolicyHolderV2: "0x5ee0c7dd",
      IERC721Receiver: "0x150b7a02",
      IERC4626: "0x87dfe5a0",
    };
    const CashFlowLender = await ethers.getContractFactory("CashFlowLender");
    const cfl = await CashFlowLender.deploy(ZeroAddress, ZeroAddress);

    /* eslint-disable no-unused-expressions */
    expect(await cfl.supportsInterface(interfaceIds.IERC165)).to.be.true;
    expect(await cfl.supportsInterface(interfaceIds.IERC721Receiver)).to.be.true;
    expect(await cfl.supportsInterface(interfaceIds.IERC721)).to.be.false; // Not an NFT collection
    expect(await cfl.supportsInterface(interfaceIds.IPolicyHolder)).to.be.true;
    expect(await cfl.supportsInterface(interfaceIds.IPolicyHolderV2)).to.be.true;
    expect(await cfl.supportsInterface(interfaceIds.IERC20)).to.be.true;
    expect(await cfl.supportsInterface(interfaceIds.IERC20Metadata)).to.be.true;
    expect(await cfl.supportsInterface(interfaceIds.IERC4626)).to.be.true;
    expect(await cfl.supportsInterface(invalidInterfaceId)).to.be.false;
  });
});
