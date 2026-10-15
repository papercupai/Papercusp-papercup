// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IEquityGovernorBinding {
    function equity() external view returns (address);
    function timelock() external view returns (address);
}
interface IEquityTimelockBinding { function governor() external view returns (address); }

/// Issuer-attested ownership register. Legal effectiveness depends on the named issuer's
/// binding documents; a digest alone does not establish a company or securities exemption.
/// Non-upgradeable: no discretionary mint, burn, confiscation or administrator role.
contract PapercuspEquity is ERC20, ERC20Votes {
    using Checkpoints for Checkpoints.Trace208;
    uint256 public constant MAX_HOLDERS = 256;
    uint16 public constant ANNUAL_RETURN_CAP_BPS = 1000;
    uint48 public constant MIN_RETURN_INTERVAL = 30 days;
    address public immutable bootstrap;
    bytes32 public immutable issuerCommitment;
    string public legalRegisterURI;
    uint208 public immutable supplyCap;
    uint208 public immutable genesisShares;
    address public authority;
    bool public genesisActivated;
    uint208 public grantLimit;
    uint256 public reservedSupply;
    uint256 public holderCount;
    uint48 public lastReturnAt;
    uint48 public returnWindowStart;
    uint16 public returnWindowBps;
    bool private _recovering;

    struct Holder { address wallet; bytes32 identityCommitment; bool eligible; bool accepted; address recoveryAgent; address recoveryDestination; }
    struct Grant { uint256 holderId; uint208 amount; uint208 claimed; uint48 start; uint48 end; uint48 stoppedAt; }
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
    event IssuerActivated(bytes32 indexed commitment, string registerURI);
    event GovernanceBound(address indexed governor, address indexed timelock);
    event HolderRegistered(uint256 indexed holderId, address indexed wallet, bytes32 identityCommitment);
    event TermsAccepted(uint256 indexed holderId, address indexed wallet, bytes32 commitment);
    event EligibilityChanged(uint256 indexed holderId, bool eligible);
    event GrantCommitted(bytes32 indexed grantId, uint256 indexed holderId, uint208 shares, uint48 start, uint48 end);
    event GrantClaimed(bytes32 indexed grantId, uint256 shares);
    event GrantStopped(bytes32 indexed grantId, uint48 at, uint256 retainedEarned);
    event ReturnDeclared(bytes32 indexed returnId, uint48 recordTime, uint16 bps, uint256 shares);
    event ReturnClaimed(bytes32 indexed returnId, uint256 indexed holderId, uint256 shares);
    event WalletRecovered(uint256 indexed holderId, address indexed previousWallet, address indexed newWallet);

    constructor(bytes32 commitment, string memory registerURI, uint208 cap, uint208 initialShares)
        ERC20("Papercusp Equity", "PCE") EIP712("Papercusp Equity", "1")
    {
        if (commitment == 0 || bytes(registerURI).length == 0 || cap == 0 || initialShares == 0 || initialShares > cap) revert Invalid();
        bootstrap = msg.sender;
        issuerCommitment = commitment;
        legalRegisterURI = registerURI;
        supplyCap = cap;
        genesisShares = initialShares;
        grantLimit = cap / 10;
    }
    modifier onlyAuthority() { if (msg.sender != authority || authority == address(0)) revert Forbidden(); _; }
    function decimals() public pure override returns (uint8) { return 0; }
    function clock() public view override returns (uint48) { return uint48(block.timestamp); }
    function CLOCK_MODE() public pure override returns (string memory) { return "mode=timestamp"; }

    /// The issuer wallet attests the external documents and accepts its own genesis equity.
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
    /// One-time wiring, then bootstrap has no further administrative power.
    function bindGovernance(address governor, address timelock_) external {
        if (msg.sender != bootstrap || !genesisActivated || authority != address(0)) revert Forbidden();
        if (governor.code.length == 0 || timelock_.code.length == 0 ||
            IEquityGovernorBinding(governor).equity() != address(this) ||
            IEquityGovernorBinding(governor).timelock() != timelock_ ||
            IEquityTimelockBinding(timelock_).governor() != governor) revert Invalid();
        authority = timelock_;
        emit GovernanceBound(governor, timelock_);
    }
    function registerHolder(address wallet, bytes32 identityCommitment) external onlyAuthority returns (uint256) {
        return _register(wallet, identityCommitment);
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
    function acceptTerms(bytes32 commitment) external {
        uint256 id = memberId(msg.sender);
        if (id == 0 || commitment != issuerCommitment) revert Invalid();
        holders[id].accepted = true;
        _recordHolder(id);
        emit TermsAccepted(id, msg.sender, commitment);
    }
    function setEligibility(uint256 id, bool eligible) external onlyAuthority {
        if (holders[id].wallet == address(0)) revert Invalid();
        holders[id].eligible = eligible;
        _recordHolder(id);
        emit EligibilityChanged(id, eligible);
    }
    function setGrantLimit(uint208 limit) external onlyAuthority {
        if (limit == 0 || limit > supplyCap / 10) revert Capacity();
        grantLimit = limit; // prospective only; never changes an existing commitment
    }
    function commitGrant(bytes32 grantId, address wallet, uint208 amount, uint48 start, uint48 end) external onlyAuthority {
        uint256 id = memberId(wallet);
        if (grantId == 0 || grants[grantId].holderId != 0 || id == 0 || amount == 0 || amount > grantLimit ||
            end <= start || end - start > 3650 days) revert Invalid();
        _requireEligible(wallet);
        _reserve(amount);
        grants[grantId] = Grant(id, amount, 0, start, end, 0);
        emit GrantCommitted(grantId, id, amount, start, end);
    }
    function earnedGrant(bytes32 grantId) public view returns (uint256) {
        Grant storage g = grants[grantId];
        uint48 at = g.stoppedAt == 0 ? clock() : g.stoppedAt;
        if (at <= g.start) return 0;
        if (at >= g.end) return g.amount;
        return Math.mulDiv(g.amount, at - g.start, g.end - g.start);
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
    function stopGrant(bytes32 grantId) external onlyAuthority {
        Grant storage g = grants[grantId];
        if (g.holderId == 0 || g.stoppedAt != 0) revert Invalid();
        uint256 earned = earnedGrant(grantId);
        g.stoppedAt = clock();
        reservedSupply -= g.amount - earned;
        emit GrantStopped(grantId, g.stoppedAt, earned);
    }
    /// Fixed record, bounded enumeration, exact integer entitlements. Reserved amounts
    /// include unclaimed returns and grants; claims cannot capture newly minted shares.
    function declareReturn(bytes32 returnId, uint16 bps) external onlyAuthority {
        if (returnId == 0 || shareReturns[returnId].exists || bps == 0 || bps > ANNUAL_RETURN_CAP_BPS ||
            (lastReturnAt != 0 && clock() < lastReturnAt + MIN_RETURN_INTERVAL)) revert Invalid();
        if (returnWindowStart == 0 || clock() >= returnWindowStart + 365 days) {
            returnWindowStart = clock(); returnWindowBps = 0;
        }
        if (uint256(returnWindowBps) + bps > ANNUAL_RETURN_CAP_BPS) revert Capacity();
        uint48 recordTime = clock() - 1;
        uint256 sum;
        for (uint256 id = 1; id <= holderCount; ++id) {
            if (_eligibility[id].upperLookupRecent(recordTime) == 0) continue;
            uint256 entitlement = Math.mulDiv(_shares[id].upperLookupRecent(recordTime), bps, 10000);
            returnEntitlement[returnId][id] = entitlement;
            sum += entitlement;
        }
        if (sum == 0) revert NothingEarned();
        _reserve(sum);
        shareReturns[returnId] = ShareReturn(recordTime, bps, sum, true);
        returnWindowBps += bps;
        lastReturnAt = clock();
        emit ReturnDeclared(returnId, recordTime, bps, sum);
    }
    function claimReturn(bytes32 returnId) external {
        uint256 id = memberId(msg.sender);
        uint256 amount = returnEntitlement[returnId][id];
        if (id == 0 || amount == 0 || returnClaimed[returnId][id]) revert NothingEarned();
        _requireEligible(msg.sender);
        returnClaimed[returnId][id] = true;
        reservedSupply -= amount;
        _mint(msg.sender, amount);
        emit ReturnClaimed(returnId, id, amount);
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
    /// Stable id carries outstanding grants and fixed-record return entitlements.
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
        // Otherwise freezing the last holder makes governance restoration impossible.
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
