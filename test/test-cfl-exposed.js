const { expect } = require("chai");
const { DAY, HOUR, WEEK } = require("@ensuro/utils/js/constants");

const hre = require("hardhat");
const { ethers } = hre;
const { ZeroAddress } = ethers;
const helpers = require("@nomicfoundation/hardhat-network-helpers");

async function setUp() {
  const $CashFlowLender = await ethers.getContractFactory("$CashFlowLender");
  const cfl = await $CashFlowLender.deploy(ZeroAddress, ZeroAddress);
  return {
    $CashFlowLender,
    cfl,
  };
}

function sum(array) {
  return array.reduce((accum, curr) => accum + curr, 0);
}

describe("CashFlowLender pure functions tests", function () {
  it("Computes the right month for non leap years", async () => {
    const { cfl } = await helpers.loadFixture(setUp);
    const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let month = 1;

    expect(await cfl.$_getMonth(0, false)).to.equal(1);
    for (let i = 1; i < 365; i++) {
      if (i === sum(monthDays.slice(0, month))) month += 1;
      expect(await cfl.$_getMonth(i, false)).to.equal(month);
    }
  });

  it("Computes the right month for leap years", async () => {
    const { cfl } = await helpers.loadFixture(setUp);
    const monthDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let month = 1;

    expect(await cfl.$_getMonth(0, true)).to.equal(1);
    for (let i = 1; i < 366; i++) {
      if (i === sum(monthDays.slice(0, month))) month += 1;
      expect(await cfl.$_getMonth(i, true)).to.equal(month);
    }
  });

  it("Computes the right calendar month for 1000 random values from Jan 1st 2025", async () => {
    const { cfl } = await helpers.loadFixture(setUp);
    const jan1st2025 = 1735689600;
    let testDate = jan1st2025;
    const SLOTSIZE_CALENDAR_MONTH = await cfl.SLOTSIZE_CALENDAR_MONTH();

    for (let i = 0; i < 1000; i++) {
      const testDateAsDate = new Date(testDate * 1000);
      const expected = testDateAsDate.getUTCFullYear() * 100 + testDateAsDate.getUTCMonth() + 1;
      expect(await cfl.$_computeCalendarMonth(testDate)).to.equal(expected);
      expect(await cfl.$_makeSlotIndex(SLOTSIZE_CALENDAR_MONTH, testDate)).to.equal(expected);
      testDate += Math.round(DAY * 30 * Math.random());
    }
  });

  it("Computes the slot index as slots since 1970 for non calendar month periods", async () => {
    const { cfl } = await helpers.loadFixture(setUp);
    const slotSizes = [HOUR, DAY, WEEK, DAY * 30];

    for (const slotSize of slotSizes) {
      for (let i = 0; i < 10; i++) {
        const expected = Math.round(Math.random() * 1000);
        // Beginning of the slot
        expect(await cfl.$_makeSlotIndex(slotSize, expected * slotSize)).to.equal(expected);
        // End of the slot
        expect(await cfl.$_makeSlotIndex(slotSize, expected * (slotSize + 1) - 1)).to.equal(expected);
        // Somewhere in the middle
        expect(
          await cfl.$_makeSlotIndex(slotSize, expected * slotSize + Math.round(slotSize * Math.random()))
        ).to.equal(expected);
      }
    }
  });

  it("Checks there are no bit overlaps in _makeTargetSlot function ", async () => {
    const { cfl } = await helpers.loadFixture(setUp);
    const [addr1, addr2] = await hre.ethers.getSigners();

    const SLOTSIZE_CALENDAR_MONTH = await cfl.SLOTSIZE_CALENDAR_MONTH();
    const slotSizes = [HOUR, DAY, WEEK, DAY * 30, SLOTSIZE_CALENDAR_MONTH];
    const slotIndexes = Array.from({ length: 10 }, () => Math.round(Math.random() * 100));
    slotIndexes.push(0);
    slotIndexes.push(2 ** 32 - 1);

    for (const slotSize of slotSizes) {
      for (const slotIndex of slotIndexes) {
        const slotAddr1 = await cfl.$_makeTargetSlot(addr1, slotSize, slotIndex);
        const slotAddr2 = await cfl.$_makeTargetSlot(addr2, slotSize, slotIndex);
        expect(slotAddr1.startsWith(addr1.address.toLowerCase())).to.equal(true);
        expect(slotAddr2.startsWith(addr2.address.toLowerCase())).to.equal(true);
        expect(slotAddr1.slice(42)).to.equal(slotAddr2.slice(42)); // Last 96 bits are equal
        expect(parseInt(slotAddr1.slice(42, 50), 16)).to.equal(slotSize);
        expect(parseInt(slotAddr1.slice(50, 58), 16)).to.equal(slotIndex);
        expect(parseInt(slotAddr1.slice(58), 16)).to.equal(0);
      }
    }
  });

  it("Checks makeFakeSelector doesn't have colisions", async () => {
    const { cfl } = await helpers.loadFixture(setUp);
    const [addr1, addr2] = await hre.ethers.getSigners();

    // Reasonable random test that checks makeFakeSelector doesn't collide for 100 random samples
    const selectors = Array.from({ length: 100 }, () => Math.round(Math.random() * 2 ** 32));
    selectors.push(0);
    selectors.push(2 ** 32 - 1);

    const fakeSelectors = [];

    for (const selector of selectors) {
      fakeSelectors.push(await cfl.makeFakeSelector(addr1, `0x${selector.toString(16).padStart(8, "0")}`));
      fakeSelectors.push(await cfl.makeFakeSelector(addr2, `0x${selector.toString(16).padStart(8, "0")}`));
      fakeSelectors.push(await cfl.makeFakeSelector(ZeroAddress, `0x${selector.toString(16).padStart(8, "0")}`));
    }
    const uniqueSelectors = fakeSelectors.filter((value, index, array) => array.indexOf(value) === index);
    expect(fakeSelectors.length).to.equal(uniqueSelectors.length);
  });
});
