// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract HodlOrDie {
    address public owner;
    uint256 public currentRoundId;
    uint256 public entryFee;       // tek deneme ücreti (wei)
    uint256 public pot;            // o anki round'un potu (wei)
    uint256 public currentRoundStart;
    bool public currentRoundFinalized;

    event Joined(address indexed player, uint256 indexed roundId, uint256 amount);
    event RoundFinalized(
        uint256 indexed roundId,
        address indexed winner,
        uint256 winnerAmount,
        uint256 ownerFee
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(uint256 _entryFeeWei) {
        owner = msg.sender;              // deploy eden = fee alan
        entryFee = _entryFeeWei;
        currentRoundId = 1;
        currentRoundStart = block.timestamp;
        currentRoundFinalized = false;
    }

    // Frontend'in kullandığı: her girişte entryFee kadar ETH gönderilecek
    function joinCurrentRound() external payable {
        require(!currentRoundFinalized, "round finalized");
        require(msg.value == entryFee, "wrong entry fee");

        pot += msg.value;
        emit Joined(msg.sender, currentRoundId, msg.value);
    }

    // Frontend + backend'in okuduğu fonksiyon
    function getCurrentRoundInfo()
        external
        view
        returns (
            uint256 id,
            uint256 pot_,
            uint256 start,
            uint256 end,
            bool finalized
        )
    {
        id = currentRoundId;
        pot_ = pot;
        start = currentRoundStart;
        end = 0;                  // şu an bitiş süresi kullanmıyoruz
        finalized = currentRoundFinalized;
    }

    // Backend winner seçince bunu çağıracak
    // %95 winner'a, %5 owner'a gidiyor
    function finalizeRound(address winner) external onlyOwner {
        require(!currentRoundFinalized, "already finalized");
        require(winner != address(0), "invalid winner");

        uint256 amount = pot;
        require(amount > 0, "no pot");

        currentRoundFinalized = true;
        pot = 0;

        uint256 ownerFee = (amount * 5) / 100;   // %5
        uint256 payout   = amount - ownerFee;    // %95

        (bool ok1, ) = winner.call{value: payout}("");
        require(ok1, "winner payout failed");

        (bool ok2, ) = owner.call{value: ownerFee}("");
        require(ok2, "owner fee failed");

        emit RoundFinalized(currentRoundId, winner, payout, ownerFee);

        // yeni round
        currentRoundId += 1;
        currentRoundStart = block.timestamp;
        currentRoundFinalized = false;
    }

    receive() external payable {
        revert("send via joinCurrentRound");
    }
}
