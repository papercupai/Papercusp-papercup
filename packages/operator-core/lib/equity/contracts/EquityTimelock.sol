// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// Only the bound governor can schedule, cancel or execute. No open executor,
/// external administrator, role-change or timelock-delay bypass.
contract EquityTimelock is TimelockController {
    uint256 public constant DELAY_FLOOR = 1 days;
    address public immutable initializer;
    address public governor;
    error Sealed();
    constructor(uint256 delay) TimelockController(delay, new address[](0), new address[](0), address(0)) {
        if (delay < DELAY_FLOOR) revert Sealed();
        initializer = msg.sender;
    }
    function initializeGovernor(address governor_) external {
        if (msg.sender != initializer || governor != address(0) || governor_.code.length == 0) revert Sealed();
        governor = governor_;
        _grantRole(PROPOSER_ROLE, governor_);
        _grantRole(EXECUTOR_ROLE, governor_);
        _grantRole(CANCELLER_ROLE, governor_);
    }
    function grantRole(bytes32, address) public pure override { revert Sealed(); }
    function revokeRole(bytes32, address) public pure override { revert Sealed(); }
    function renounceRole(bytes32, address) public pure override { revert Sealed(); }
    function updateDelay(uint256 delay) public override {
        if (delay < DELAY_FLOOR) revert Sealed();
        super.updateDelay(delay);
    }
}
