// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title HODL OR DIE - Weekly Pot (MVP)
/// @notice Pot toplar, haftalık winner'lara öder, %5 fee alır.
/// Skor backend'de tutulur, burada sadece para & round yönetimi var.
contract HodlOrDieWeekly {
    address public owner;

    uint256 public entryFee;           // örn: 0.0003 ether
    uint256 public houseFeeBps = 500;  // %5
    uint256 public currentRoundId;

    struct Round {
        uint256 totalPot;
        uint256 startTimestamp;
        uint256 endTimestamp;
        bool finalized;
    }

    mapping(uint256 => Round) public rounds;
    uint256 public collectedFees;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    event RoundStarted(uint256 indexed roundId, uint256 start, uint256 end);
    event Joined(uint256 indexed roundId, address indexed player, uint256 amount);
    event RoundFinalized(uint256 indexed roundId, address[] winners, uint256 prizePool, uint256 fee);
    event FeesWithdrawn(address indexed to, uint256 amount);

    constructor(uint256 _entryFee, uint256 _firstRoundEnd) payable {
        owner = msg.sender;
        entryFee = _entryFee;

        currentRoundId = 1;
        rounds[currentRoundId] = Round({
            totalPot: 0,
            startTimestamp: block.timestamp,
            endTimestamp: _firstRoundEnd,
            finalized: false
        });

        emit RoundStarted(currentRoundId, block.timestamp, _firstRoundEnd);
    }

    /// @notice Oyuna katılmak için ~1$ civarı entry fee ödenir.
    function joinCurrentRound() external payable {
        Round storage r = rounds[currentRoundId];
        require(block.timestamp < r.endTimestamp, "round ended");
        require(msg.value == entryFee, "wrong entryFee");

        r.totalPot += msg.value;

        emit Joined(currentRoundId, msg.sender, msg.value);
    }

    /// @notice Haftalık kazananlar backend tarafından hesaplanır, buraya adres listesi girilir.
    /// Pot, kazananlara eşit bölünür (%5 fee çıktıktan sonra).
    function finalizeCurrentRound(address[] calldata _winners) external onlyOwner {
        require(_winners.length > 0, "no winners");

        Round storage r = rounds[currentRoundId];
        require(block.timestamp >= r.endTimestamp, "round not ended yet");
        require(!r.finalized, "already finalized");
        require(r.totalPot > 0, "no pot");

        r.finalized = true;

        uint256 fee = (r.totalPot * houseFeeBps) / 10000;
        uint256 prizePool = r.totalPot - fee;
        collectedFees += fee;

        uint256 share = prizePool / _winners.length;

        for (uint256 i = 0; i < _winners.length; i++) {
            require(_winners[i] != address(0), "winner zero");
            (bool ok, ) = _winners[i].call{value: share}("");
            require(ok, "payout fail");
        }

        emit RoundFinalized(currentRoundId, _winners, prizePool, fee);

        _startNextRound();
    }

    function _startNextRound() internal {
        currentRoundId += 1;

        uint256 prevEnd = rounds[currentRoundId - 1].endTimestamp;
        uint256 nextEnd = prevEnd + 7 days;

        rounds[currentRoundId] = Round({
            totalPot: 0,
            startTimestamp: block.timestamp,
            endTimestamp: nextEnd,
            finalized: false
        });

        emit RoundStarted(currentRoundId, block.timestamp, nextEnd);
    }

    /// @notice Biriken fee'leri owner çekebilir.
    function withdrawFees(address payable to) external onlyOwner {
        uint256 amount = collectedFees;
        require(amount > 0, "no fees");
        collectedFees = 0;

        (bool ok, ) = to.call{value: amount}("");
        require(ok, "withdraw fail");

        emit FeesWithdrawn(to, amount);
    }

    /// @notice EntryFee'yi zamanla güncelleyebilmek için.
    function setEntryFee(uint256 _entryFee) external onlyOwner {
        entryFee = _entryFee;
    }

    function getCurrentRoundInfo()
        external
        view
        returns (uint256 id, uint256 pot, uint256 start, uint256 end, bool finalized)
    {
        Round storage r = rounds[currentRoundId];
        return (currentRoundId, r.totalPot, r.startTimestamp, r.endTimestamp, r.finalized);
    }
}