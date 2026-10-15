// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;
import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorCountingSimple} from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {GovernorTimelockControl} from "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {PapercuspEquity} from "./PapercuspEquity.sol";

/// Each proposal freezes its prior approval policy. Both a majority of individual
/// eligible members and a majority of economic voting power must approve. Changes
/// to supported rules require protected supermajorities; immutable floors remain.
contract EquityGovernor is Governor, GovernorCountingSimple, GovernorVotes, GovernorTimelockControl {
    uint16 public constant NORMAL_FLOOR = 5001;
    uint16 public constant PROTECTED_FLOOR = 6667;
    uint32 public constant VOTING_DELAY_FLOOR = 60;
    uint32 public constant VOTING_PERIOD_FLOOR = 1 hours;
    PapercuspEquity public immutable equity;
    uint16 public normalApprovalBps = 6000;
    uint16 public protectedApprovalBps = 7500;
    uint32 private _delay = 60;
    uint32 private _period = 1 days;
    struct ProposalPolicy { uint16 approvalBps; uint256 membersFor; uint256 membersAgainst; }
    mapping(uint256 => ProposalPolicy) public proposalPolicy;
    mapping(uint256 => mapping(uint256 => bool)) public memberHasVoted;
    error UnsupportedAction();
    error PolicyFloor();
    error NotMember();
    constructor(PapercuspEquity token_, TimelockController timelock_)
        Governor("Papercusp Equity Governor") GovernorVotes(IVotes(address(token_))) GovernorTimelockControl(timelock_)
    { equity = token_; }
    function votingDelay() public view override returns (uint256) { return _delay; }
    function votingPeriod() public view override returns (uint256) { return _period; }
    function quorum(uint256 timepoint) public view override returns (uint256) {
        return (equity.getPastTotalSupply(timepoint) * NORMAL_FLOOR + 9999) / 10000;
    }
    function setPolicy(uint16 normalBps, uint16 protectedBps, uint32 delay_, uint32 period_) external onlyGovernance {
        if (normalBps < NORMAL_FLOOR || protectedBps < PROTECTED_FLOOR || protectedBps < normalBps ||
            protectedBps > 10000 || delay_ < VOTING_DELAY_FLOOR || period_ < VOTING_PERIOD_FLOOR ||
            delay_ > 30 days || period_ > 30 days) revert PolicyFloor();
        normalApprovalBps = normalBps; protectedApprovalBps = protectedBps; _delay = delay_; _period = period_;
    }
    function propose(address[] memory targets, uint256[] memory values, bytes[] memory calldatas, string memory description)
        public override returns (uint256 id)
    {
        uint256 member = equity.memberId(msg.sender);
        if (member == 0 || equity.getPastMember(member, clock() - 1) == 0) revert NotMember();
        if (targets.length == 0 || targets.length > 16 || targets.length != values.length || targets.length != calldatas.length) revert UnsupportedAction();
        bool protectedAction;
        for (uint256 i = 0; i < targets.length; ++i) {
            if (values[i] != 0 || calldatas[i].length < 4) revert UnsupportedAction();
            bytes4 selector = bytes4(calldatas[i]);
            if (targets[i] == address(equity)) {
                if (selector == PapercuspEquity.setGrantLimit.selector) protectedAction = true;
                else if (selector != PapercuspEquity.registerHolder.selector && selector != PapercuspEquity.setEligibility.selector &&
                    selector != PapercuspEquity.commitGrant.selector && selector != PapercuspEquity.stopGrant.selector &&
                    selector != PapercuspEquity.declareReturn.selector) revert UnsupportedAction();
            } else if (targets[i] == address(this) && selector == this.setPolicy.selector) protectedAction = true;
            else if (targets[i] == timelock() && selector == TimelockController.updateDelay.selector) protectedAction = true;
            else revert UnsupportedAction();
        }
        id = super.propose(targets, values, calldatas, description);
        proposalPolicy[id].approvalBps = protectedAction ? protectedApprovalBps : normalApprovalBps;
    }
    function _countVote(uint256 id, address account, uint8 support, uint256 weight, bytes memory params)
        internal override(Governor, GovernorCountingSimple) returns (uint256)
    {
        uint256 member = equity.memberId(account);
        if (member == 0 || equity.getPastMember(member, proposalSnapshot(id)) == 0 || memberHasVoted[id][member]) revert NotMember();
        memberHasVoted[id][member] = true;
        if (support == 1) ++proposalPolicy[id].membersFor;
        else if (support == 0) ++proposalPolicy[id].membersAgainst;
        return super._countVote(id, account, support, weight, params);
    }
    function _quorumReached(uint256 id) internal view override(Governor, GovernorCountingSimple) returns (bool) {
        (, uint256 sharesFor,) = proposalVotes(id);
        ProposalPolicy storage p = proposalPolicy[id];
        uint256 snapshot = proposalSnapshot(id);
        return sharesFor * 10000 >= equity.getPastTotalSupply(snapshot) * p.approvalBps &&
            p.membersFor * 10000 >= equity.getPastMemberCount(snapshot) * p.approvalBps;
    }
    function _voteSucceeded(uint256 id) internal view override(Governor, GovernorCountingSimple) returns (bool) {
        return super._voteSucceeded(id) && proposalPolicy[id].membersFor > proposalPolicy[id].membersAgainst;
    }
    function state(uint256 id) public view override(Governor, GovernorTimelockControl) returns (ProposalState) { return super.state(id); }
    function proposalNeedsQueuing(uint256 id) public view override(Governor, GovernorTimelockControl) returns (bool) { return super.proposalNeedsQueuing(id); }
    function _queueOperations(uint256 id, address[] memory targets, uint256[] memory values, bytes[] memory data, bytes32 hash)
        internal override(Governor, GovernorTimelockControl) returns (uint48) { return super._queueOperations(id, targets, values, data, hash); }
    function _executeOperations(uint256 id, address[] memory targets, uint256[] memory values, bytes[] memory data, bytes32 hash)
        internal override(Governor, GovernorTimelockControl) { super._executeOperations(id, targets, values, data, hash); }
    function _cancel(address[] memory targets, uint256[] memory values, bytes[] memory data, bytes32 hash)
        internal override(Governor, GovernorTimelockControl) returns (uint256) { return super._cancel(targets, values, data, hash); }
    function _executor() internal view override(Governor, GovernorTimelockControl) returns (address) { return super._executor(); }
}
