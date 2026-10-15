// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IEquityGovernorBindingV2 {
    function equity() external view returns (address);
    function timelock() external view returns (address);
}
interface IEquityTimelockBindingV2 { function governor() external view returns (address); }

/// Version 2 of the issuer-attested ownership register (dao-hr-people-2026-10-11 D-004, D-008).
/// Member votes (the timelock `authority`) are needed to hire (register a holder, commit a
/// grant) and to fire (stop a grant), plus two safety actions that are not routine operations:
/// a legal eligibility freeze and replacing a lost or compromised admin.
/// A bounded `admin` runs routine operations without a vote: prospective policy values within
/// immutable maxima, raising an unvested grant within the per-grant limit, and triggering a due
/// payout. No admin path reduces earned equity, stops a grant, registers a holder, creates a
/// grant, or exceeds the immutable return ceiling and minimum payout interval. A holder can stop
/// vesting on only their own grant (resignation); earned equity stays.
/// Non-upgradeable: no discretionary mint, burn, confiscation or role-change path.
contract PapercuspEquityV2 is ERC20, ERC20Votes {
    using Checkpoints for Checkpoints.Trace208;
    uint256 public constant MAX_HOLDERS = 256;
    uint16 public constant ANNUAL_RETURN_CAP_BPS = 1000;
    uint48 public constant MIN_RETURN_INTERVAL = 30 days;
    uint48 public constant MAX_RETURN_INTERVAL = 365 days;
    uint48 public constant MAX_GRANT_DURATION = 3650 days;
    address public immutable bootstrap;
    bytes32 public immutable issuerCommitment;
    string public legalRegisterURI;
    uint208 public immutable supplyCap;
    uint208 public immutable genesisShares;
    uint208 public immutable maxGrantLimit;
    address public authority;
    address public admin;
    bool public genesisActivated;
    uint208 public grantLimit;
    uint16 public returnRateBps;
    uint48 public returnInterval;
    uint256 public reservedSupply;
    uint256 public holderCount;
    uint48 public lastReturnAt;
    uint48 public returnWindowStart;
    uint16 public returnWindowBps;
    bool private _recovering;

    struct Holder { address wallet; bytes32 identityCommitment; bool eligible; bool accepted; address recoveryAgent; address recoveryDestination; }
    struct Grant { uint256 holderId; uint208 amount; uint208 claimed; uint48 start; uint48 cliff; uint48 end; uint48 stoppedAt; }
    struct ShareReturn { uint48 recordTime; uint16 bps; uint256 shares; bool exists; }
    mapping(uint256 => Holder) public holders;
    mapping(address => uint256) public walletId;
    mapping(bytes32 => bool) public registeredIdentity;
    mapping(bytes32 => Grant) public grants;
    mapping(bytes32 => ShareReturn) public shareReturns;
    mapping(bytes32 => mapping(uint256 => uint256)) public returnEntitlement;
    mapping(bytes32 => mapping(uint256 => bool)) public returnClaimed;
    mapping(uint256 => Checkpoints.Trace208) private _shares;
    mapping(uint256 => Checkpoints.Trace208) private _eligibility;
    mapping(uint256 => Checkpoints.Trace208) private _membership;
    Checkpoints.Trace208 private _memberCount;

    error Forbidden();
    error Invalid();
    error Ineligible();
    error Capacity();
    error NothingEarned();
    error NotDue();
    event IssuerActivated(bytes32 indexed commitment, string registerURI);
    event GovernanceBound(address indexed governor, address indexed timelock);
    event AdminChanged(address indexed previousAdmin, address indexed newAdmin);
    event HolderRegistered(uint256 indexed holderId, address indexed wallet, bytes32 identityCommitment);
    event TermsAccepted(uint256 indexed holderId, address indexed wallet, bytes32 commitment);
    event EligibilityChanged(uint256 indexed holderId, bool eligible);
    event GrantLimitChanged(uint208 limit);
    event ReturnPolicyChanged(uint16 rateBps, uint48 interval);
    event GrantCommitted(bytes32 indexed grantId, uint256 indexed holderId, uint208 shares, uint48 start, uint48 cliff, uint48 end);
    event GrantRaised(bytes32 indexed grantId, uint208 previousShares, uint208 shares);
    event GrantClaimed(bytes32 indexed grantId, uint256 shares);
    event GrantStopped(bytes32 indexed grantId, uint48 at, uint256 retainedEarned);
    event GrantResigned(bytes32 indexed grantId, uint48 at, uint256 retainedEarned);
    event PayoutTriggered(bytes32 indexed payoutId, uint48 recordTime, uint16 bps, uint256 shares);
    event ReturnClaimed(bytes32 indexed payoutId, uint256 indexed holderId, uint256 shares);
    event WalletRecovered(uint256 indexed holderId, address indexed previousWallet, address indexed newWallet);

    constructor(bytes32 commitment, string memory registerURI, uint208 cap, uint208 initialShares)
        ERC20("Papercusp Equity", "PCE") EIP712("Papercusp Equity", "2")
    {
        if (commitment == 0 || bytes(registerURI).length == 0 || cap < 10 || initialShares == 0 || initialShares > cap) revert Invalid();
        bootstrap = msg.sender;
        issuerCommitment = commitment;
        legalRegisterURI = registerURI;
        supplyCap = cap;
        genesisShares = initialShares;
        maxGrantLimit = cap / 10;
        grantLimit = cap / 10;
    }
    modifier onlyAuthority() { if (msg.sender != authority || authority == address(0)) revert Forbidden(); _; }
    modifier onlyAdmin() { if (msg.sender != admin || admin == address(0)) revert Forbidden(); _; }
    function decimals() public pure override returns (uint8) { return 0; }
    function clock() public view override returns (uint48) { return uint48(block.timestamp); }
    function CLOCK_MODE() public pure override returns (string memory) { return "mode=timestamp"; }

    // ── Bootstrap: one-time wiring, then the issuer wallet holds no administrative power. ──
    function activateGenesis(bytes32 identityCommitment, bytes32 acceptedCommitment) external {
        if (msg.sender != bootstrap || genesisActivated || authority != address(0)) revert Forbidden();
        if (acceptedCommitment != issuerCommitment) revert Invalid();
        genesisActivated = true;
        uint256 id = _register(msg.sender, identityCommitment);
        holders[id].accepted = true;
        _eligibility[id].push(clock(), 1);
        _mint(msg.sender, genesisShares);
        emit TermsAccepted(id, msg.sender, acceptedCommitment);
        emit IssuerActivated(issuerCommitment, legalRegisterURI);
    }
    function bindGovernance(address governor, address timelock_, address admin_) external {
        if (msg.sender != bootstrap || !genesisActivated || authority != address(0)) revert Forbidden();
        if (governor.code.length == 0 || timelock_.code.length == 0 ||
            IEquityGovernorBindingV2(governor).equity() != address(this) ||
            IEquityGovernorBindingV2(governor).timelock() != timelock_ ||
            IEquityTimelockBindingV2(timelock_).governor() != governor) revert Invalid();
        _setAdmin(admin_, timelock_);
        authority = timelock_;
        emit GovernanceBound(governor, timelock_);
    }

    // ── Governance only (a member vote): hire, fire, eligibility freeze, admin replacement. ──
    function registerHolder(address wallet, bytes32 identityCommitment) external onlyAuthority returns (uint256) {
        return _register(wallet, identityCommitment);
    }
    /// A zero start anchors vesting to this hire execution; cliff/end are then durations.
    /// Otherwise all three values are absolute timestamps from the signed offer.
    function commitGrant(bytes32 grantId, address wallet, uint208 amount, uint48 start, uint48 cliff, uint48 end) external onlyAuthority {
        if (start == 0) {
            if (end == 0 || end > MAX_GRANT_DURATION || cliff > end) revert Invalid();
            start = clock();
            cliff += start;
            end += start;
        }
        uint256 id = memberId(wallet);
        if (grantId == 0 || grants[grantId].holderId != 0 || id == 0 || amount == 0 || amount > grantLimit ||
            end <= start || end - start > MAX_GRANT_DURATION || cliff < start || cliff > end) revert Invalid();
        // The hire vote registers and reserves atomically. Acceptance follows the vote;
        // claimGrant still requires the holder's own acceptance before issuing shares.
        if (!holders[id].eligible) revert Ineligible();
        _reserve(amount);
        grants[grantId] = Grant(id, amount, 0, start, cliff, end, 0);
        emit GrantCommitted(grantId, id, amount, start, cliff, end);
    }
    function stopGrant(bytes32 grantId) external onlyAuthority {
        Grant storage g = grants[grantId];
        if (g.holderId == 0 || g.stoppedAt != 0) revert Invalid();
        emit GrantStopped(grantId, clock(), _stop(grantId, g));
    }
    function setEligibility(uint256 id, bool eligible) external onlyAuthority {
        if (holders[id].wallet == address(0)) revert Invalid();
        holders[id].eligible = eligible;
        _recordHolder(id);
        emit EligibilityChanged(id, eligible);
    }
    function replaceAdmin(address newAdmin) external onlyAuthority { _setAdmin(newAdmin, authority); }

    // ── Admin (no vote), bounded by immutable maxima; never reduces earned equity. ──
    function transferAdmin(address newAdmin) external onlyAdmin { _setAdmin(newAdmin, authority); }
    function setGrantLimit(uint208 limit) external onlyAdmin {
        if (limit == 0 || limit > maxGrantLimit) revert Capacity();
        grantLimit = limit; // prospective only; never changes an existing commitment
        emit GrantLimitChanged(limit);
    }
    function setReturnPolicy(uint16 rateBps, uint48 interval) external onlyAdmin {
        if (rateBps == 0 || rateBps > ANNUAL_RETURN_CAP_BPS || interval < MIN_RETURN_INTERVAL || interval > MAX_RETURN_INTERVAL) revert Invalid();
        returnRateBps = rateBps;
        returnInterval = interval;
        emit ReturnPolicyChanged(rateBps, interval);
    }
    /// Raises an unvested grant; the earned share of a larger grant can only grow.
    function raiseGrant(bytes32 grantId, uint208 amount) external onlyAdmin {
        Grant storage g = grants[grantId];
        if (g.holderId == 0 || g.stoppedAt != 0 || clock() >= g.end || amount <= g.amount) revert Invalid();
        if (amount > grantLimit) revert Capacity();
        _requireEligible(holders[g.holderId].wallet);
        uint208 previous = g.amount;
        _reserve(amount - previous);
        g.amount = amount;
        emit GrantRaised(grantId, previous, amount);
    }
    /// A due payout at the admin-set rate: fixed prior-second record, bounded enumeration,
    /// exact integer entitlements claimed by each holder. Additional equity, never cash.
    function triggerPayout(bytes32 payoutId) external onlyAdmin {
        uint16 bps = returnRateBps;
        if (payoutId == 0 || shareReturns[payoutId].exists || bps == 0 || bps > ANNUAL_RETURN_CAP_BPS) revert Invalid();
        uint48 interval = returnInterval < MIN_RETURN_INTERVAL ? MIN_RETURN_INTERVAL : returnInterval;
        if (lastReturnAt != 0 && clock() < lastReturnAt + interval) revert NotDue();
        if (returnWindowStart == 0 || clock() >= returnWindowStart + 365 days) {
            returnWindowStart = clock(); returnWindowBps = 0;
        }
        if (uint256(returnWindowBps) + bps > ANNUAL_RETURN_CAP_BPS) revert Capacity();
        uint48 recordTime = clock() - 1;
        uint256 sum;
        for (uint256 id = 1; id <= holderCount; ++id) {
            if (_eligibility[id].upperLookupRecent(recordTime) == 0) continue;
            uint256 entitlement = Math.mulDiv(_shares[id].upperLookupRecent(recordTime), bps, 10000);
            returnEntitlement[payoutId][id] = entitlement;
            sum += entitlement;
        }
        if (sum == 0) revert NothingEarned();
        _reserve(sum);
        shareReturns[payoutId] = ShareReturn(recordTime, bps, sum, true);
        returnWindowBps += bps;
        lastReturnAt = clock();
        emit PayoutTriggered(payoutId, recordTime, bps, sum);
    }

    // ── Anyone, scoped to the caller's own position. ──
    function acceptTerms(bytes32 commitment) external {
        uint256 id = memberId(msg.sender);
        if (id == 0 || commitment != issuerCommitment) revert Invalid();
        holders[id].accepted = true;
        _recordHolder(id);
        emit TermsAccepted(id, msg.sender, commitment);
    }
    function claimGrant(bytes32 grantId) external {
        Grant storage g = grants[grantId];
        if (g.holderId == 0 || memberId(msg.sender) != g.holderId) revert Forbidden();
        _requireEligible(msg.sender);
        uint256 amount = earnedGrant(grantId) - g.claimed;
        if (amount == 0) revert NothingEarned();
        g.claimed += uint208(amount);
        reservedSupply -= amount;
        _mint(msg.sender, amount);
        emit GrantClaimed(grantId, amount);
    }
    /// Resignation: the holder stops vesting on their own grant; earned equity stays.
    function resignGrant(bytes32 grantId) external {
        Grant storage g = grants[grantId];
        if (g.holderId == 0 || memberId(msg.sender) != g.holderId) revert Forbidden();
        if (g.stoppedAt != 0) revert Invalid();
        emit GrantResigned(grantId, clock(), _stop(grantId, g));
    }
    function claimReturn(bytes32 payoutId) external {
        uint256 id = memberId(msg.sender);
        uint256 amount = returnEntitlement[payoutId][id];
        if (id == 0 || amount == 0 || returnClaimed[payoutId][id]) revert NothingEarned();
        _requireEligible(msg.sender);
        returnClaimed[payoutId][id] = true;
        reservedSupply -= amount;
        _mint(msg.sender, amount);
        emit ReturnClaimed(payoutId, id, amount);
    }
    function setRecoveryAgent(address agent) external {
        uint256 id = memberId(msg.sender);
        if (id == 0) revert Forbidden();
        holders[id].recoveryAgent = agent;
        holders[id].recoveryDestination = address(0);
    }
    function requestRecovery(uint256 id, address newWallet) external {
        Holder storage h = holders[id];
        if (h.wallet == address(0) || (msg.sender != h.wallet && (h.recoveryAgent == address(0) || msg.sender != h.recoveryAgent))) revert Forbidden();
        if (newWallet == address(0) || walletId[newWallet] != 0) revert Invalid();
        h.recoveryDestination = newWallet;
    }
    /// Requires both old-wallet/pre-authorized agent consent AND new-wallet consent.
    function acceptRecovery(uint256 id, bytes32 commitment) external {
        Holder storage h = holders[id];
        if (h.wallet == address(0) || h.recoveryDestination != msg.sender || walletId[msg.sender] != 0 || commitment != issuerCommitment) revert Forbidden();
        _requireEligible(h.wallet);
        address previous = h.wallet;
        h.wallet = msg.sender;
        h.recoveryAgent = address(0);
        h.recoveryDestination = address(0);
        walletId[msg.sender] = id;
        _recovering = true;
        _transfer(previous, msg.sender, balanceOf(previous));
        _recovering = false;
        emit TermsAccepted(id, msg.sender, commitment);
        emit WalletRecovered(id, previous, msg.sender);
    }

    // ── Views ──
    function earnedGrant(bytes32 grantId) public view returns (uint256) {
        Grant storage g = grants[grantId];
        uint48 at = g.stoppedAt == 0 ? clock() : g.stoppedAt;
        if (at < g.cliff || at <= g.start) return 0;
        if (at >= g.end) return g.amount;
        return Math.mulDiv(g.amount, at - g.start, g.end - g.start);
    }
    function nextPayoutAt() external view returns (uint48) {
        if (lastReturnAt == 0) return 0;
        return lastReturnAt + (returnInterval < MIN_RETURN_INTERVAL ? MIN_RETURN_INTERVAL : returnInterval);
    }
    function memberId(address wallet) public view returns (uint256) {
        uint256 id = walletId[wallet];
        return holders[id].wallet == wallet ? id : 0;
    }
    function getPastMember(uint256 id, uint256 timepoint) external view returns (uint256) {
        if (timepoint >= clock()) revert Invalid();
        return _membership[id].upperLookupRecent(uint48(timepoint));
    }
    function getPastMemberCount(uint256 timepoint) external view returns (uint256) {
        if (timepoint >= clock()) revert Invalid();
        return _memberCount.upperLookupRecent(uint48(timepoint));
    }

    // ── Internals ──
    function _stop(bytes32 grantId, Grant storage g) private returns (uint256 earned) {
        earned = earnedGrant(grantId);
        g.stoppedAt = clock();
        reservedSupply -= g.amount - earned;
    }
    function _setAdmin(address newAdmin, address timelock_) private {
        if (newAdmin == address(0) || newAdmin == timelock_ || newAdmin == bootstrap || newAdmin == address(this)) revert Invalid();
        emit AdminChanged(admin, newAdmin);
        admin = newAdmin;
    }
    function _register(address wallet, bytes32 identityCommitment) private returns (uint256 id) {
        if (wallet == address(0) || walletId[wallet] != 0 || identityCommitment == 0 || registeredIdentity[identityCommitment]) revert Invalid();
        if (holderCount == MAX_HOLDERS) revert Capacity();
        id = ++holderCount;
        walletId[wallet] = id;
        registeredIdentity[identityCommitment] = true;
        holders[id] = Holder(wallet, identityCommitment, true, false, address(0), address(0));
        emit HolderRegistered(id, wallet, identityCommitment);
    }
    function _reserve(uint256 amount) private {
        if (totalSupply() + reservedSupply + amount > supplyCap) revert Capacity();
        reservedSupply += amount;
    }
    function _requireEligible(address wallet) private view {
        uint256 id = memberId(wallet);
        if (id == 0 || !holders[id].eligible || !holders[id].accepted) revert Ineligible();
    }
    function _recordHolder(uint256 id) private {
        if (id == 0) return;
        Holder storage h = holders[id];
        uint208 shares = uint208(balanceOf(h.wallet));
        uint208 eligible = h.eligible && h.accepted ? 1 : 0;
        // Transfer/issuance eligibility cannot erase existing ownership ballots.
        uint208 member = h.accepted && shares != 0 ? 1 : 0;
        uint208 oldMember = _membership[id].latest();
        _shares[id].push(clock(), shares);
        _eligibility[id].push(clock(), eligible);
        _membership[id].push(clock(), member);
        if (member != oldMember) _memberCount.push(clock(), _memberCount.latest() + member - oldMember);
    }
    function _update(address from, address to, uint256 amount) internal override(ERC20, ERC20Votes) {
        if (!_recovering && from != address(0)) _requireEligible(from);
        if (to != address(0)) _requireEligible(to);
        super._update(from, to, amount);
        if (totalSupply() + reservedSupply > supplyCap) revert Capacity();
        _recordHolder(walletId[from]);
        _recordHolder(walletId[to]);
        if (to != address(0) && delegates(to) == address(0)) _delegate(to, to);
    }
    function _delegate(address account, address delegatee) internal override {
        if (delegatee != address(0)) _requireEligible(delegatee);
        super._delegate(account, delegatee);
    }
}
