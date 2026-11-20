// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 surface (tUSD8 on Aevum returns bool).
interface IERC20Like {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @notice EIP-3009 (USDC-style) signed transfers. tUSD8 on Aevum implements this.
///         `to` must equal `msg.sender` — the gate collects then forwards to the merchant.
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title X402Gate
/// @notice Per-request payment gate for HTTP-402 / x402 flows on QDay Aevum.
///         Each `orderId` is a one-shot payment challenge issued by a resource
///         server. Settling records a `Receipt` that binds the payer, the priced
///         resource (`resourceHash`), the amount and the timestamp on-chain —
///         an independently verifiable audit trail for machine payments.
/// @dev Derived from `Checkout.sol` in the Aevum Starter Kit (MIT, PQA Labs,
///      https://github.com/qday-io/aevum-starter-kit): same nonce-binding and
///      collect-then-forward shape; adds per-payer cumulative spend, global
///      counters, and resource-bound receipts.
///      Two settlement paths:
///      1. `settle`: payer approved the gate, then calls it (two txs, payer gas).
///      2. `settleWithAuthorization`: payer signs EIP-3009 off-chain; anyone
///         (typically the resource server, acting as relayer) submits it. The
///         payer needs no native gas — the x402 pattern.
contract X402Gate {
    struct Receipt {
        address payer;
        bytes32 resourceHash;
        uint256 amount;
        uint64 paidAt;
    }

    IERC20Like public immutable token;
    address public immutable merchant;

    mapping(bytes32 orderId => Receipt) private _receipts;

    /// @notice Cumulative tUSD8 base units settled per payer — a public per-agent ledger.
    mapping(address payer => uint256) public spentOf;
    /// @notice Cumulative base units settled across all payers.
    uint256 public totalSettled;
    /// @notice Number of orders settled.
    uint256 public settleCount;

    /// @notice `orderId` settled: payer paid `amount` for `resourceHash` at this block.
    event Settled(
        bytes32 indexed orderId,
        address indexed payer,
        bytes32 resourceHash,
        uint256 amount
    );

    error AlreadySettled(bytes32 orderId);
    error ZeroAmount();
    error ZeroAddress();
    error TransferFailed();

    constructor(address token_, address merchant_) {
        if (token_ == address(0) || merchant_ == address(0)) revert ZeroAddress();
        token = IERC20Like(token_);
        merchant = merchant_;
    }

    /// @notice The EIP-3009 nonce bound to `orderId`. Ties the signature to this
    ///         gate and order, so a relayer cannot replay it for another order.
    function authorizationNonce(bytes32 orderId) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), orderId));
    }

    /// @notice Settle `orderId` for `resourceHash` with tokens approved to this contract.
    function settle(bytes32 orderId, bytes32 resourceHash, uint256 amount) external {
        _record(orderId, resourceHash, msg.sender, amount);
        _transferFrom(msg.sender, merchant, amount);
    }

    /// @notice Settle `orderId` with an EIP-3009 `ReceiveWithAuthorization` signed by `from`.
    /// @dev The signed nonce must be `authorizationNonce(orderId)` and `to` must be this
    ///      contract. Submitted by the resource server acting as the payment relayer.
    function settleWithAuthorization(
        bytes32 orderId,
        bytes32 resourceHash,
        address from,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _record(orderId, resourceHash, from, amount);
        IERC3009(address(token)).receiveWithAuthorization(
            from,
            address(this),
            amount,
            validAfter,
            validBefore,
            authorizationNonce(orderId),
            v,
            r,
            s
        );
        _transfer(merchant, amount);
    }

    /// @notice The on-chain receipt for a settled order.
    function receiptOf(bytes32 orderId) external view returns (Receipt memory) {
        return _receipts[orderId];
    }

    function isSettled(bytes32 orderId) external view returns (bool) {
        return _receipts[orderId].payer != address(0);
    }

    function _record(bytes32 orderId, bytes32 resourceHash, address payer, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        if (_receipts[orderId].payer != address(0)) revert AlreadySettled(orderId);
        _receipts[orderId] = Receipt({
            payer: payer,
            resourceHash: resourceHash,
            amount: amount,
            paidAt: uint64(block.timestamp)
        });
        spentOf[payer] += amount;
        totalSettled += amount;
        settleCount += 1;
        emit Settled(orderId, payer, resourceHash, amount);
    }

    function _transfer(address to, uint256 amount) private {
        (bool ok, bytes memory ret) = address(token).call(
            abi.encodeWithSelector(IERC20Like.transfer.selector, to, amount)
        );
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _transferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = address(token).call(
            abi.encodeWithSelector(IERC20Like.transferFrom.selector, from, to, amount)
        );
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
