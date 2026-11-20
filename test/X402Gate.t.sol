// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {X402Gate} from "../contracts/X402Gate.sol";
import {MockUSD8} from "../contracts/MockUSD8.sol";

/// @dev Minimal HEVM cheatcode subset — avoids the forge-std dependency.
interface Vm {
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external returns (address);
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
}

contract X402GateTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    MockUSD8 token;
    X402Gate gate;
    address merchant = address(0xBEEF);
    uint256 agentKey = 0xA11CE;
    address agent;
    bytes32 constant RESOURCE = keccak256("/r/payment-readiness");

    function setUp() public {
        token = new MockUSD8();
        gate = new X402Gate(address(token), merchant);
        agent = vm.addr(agentKey);
        token.mint(agent, 1_000_000);
    }

    function test_SettleWithAuthorization() public {
        bytes32 orderId = keccak256("order-1");
        bytes32 nonce = gate.authorizationNonce(orderId);
        uint256 amount = 25_000;
        (uint8 v, bytes32 r, bytes32 s) = _signReceive(agent, address(gate), amount, 0, block.timestamp + 600, nonce);
        gate.settleWithAuthorization(orderId, RESOURCE, agent, amount, 0, block.timestamp + 600, v, r, s);
        assertTrue(gate.isSettled(orderId));
        assertEq(token.balanceOf(merchant), amount);
        assertEq(gate.spentOf(agent), amount);
        assertEq(gate.totalSettled(), amount);
        assertEq(gate.settleCount(), 1);
        X402Gate.Receipt memory rc = gate.receiptOf(orderId);
        assertEq(rc.payer, agent);
        assertEq(rc.resourceHash, RESOURCE);
        assertEq(rc.amount, amount);
    }

    function test_Settle_ApprovedPath() public {
        bytes32 orderId = keccak256("order-2");
        vm.prank(agent);
        token.approve(address(gate), 40_000);
        vm.prank(agent);
        gate.settle(orderId, RESOURCE, 40_000);
        assertEq(token.balanceOf(merchant), 40_000);
    }

    function test_DoubleSettleReverts() public {
        bytes32 orderId = keccak256("order-3");
        bytes32 nonce = gate.authorizationNonce(orderId);
        (uint8 v, bytes32 r, bytes32 s) = _signReceive(agent, address(gate), 25_000, 0, block.timestamp + 600, nonce);
        gate.settleWithAuthorization(orderId, RESOURCE, agent, 25_000, 0, block.timestamp + 600, v, r, s);
        vm.expectRevert(abi.encodeWithSelector(X402Gate.AlreadySettled.selector, orderId));
        gate.settleWithAuthorization(orderId, RESOURCE, agent, 25_000, 0, block.timestamp + 600, v, r, s);
    }

    function test_ZeroAmountReverts() public {
        bytes32 orderId = keccak256("order-4");
        vm.expectRevert(X402Gate.ZeroAmount.selector);
        gate.settle(orderId, RESOURCE, 0);
    }

    function test_ReceiptBindsResource() public {
        bytes32 orderId = keccak256("order-5");
        bytes32 nonce = gate.authorizationNonce(orderId);
        bytes32 otherResource = keccak256("/r/chain-stats");
        // signature is bound to the gate+orderId nonce; resourceHash travels with the call
        (uint8 v, bytes32 r, bytes32 s) = _signReceive(agent, address(gate), 5_000, 0, block.timestamp + 600, nonce);
        gate.settleWithAuthorization(orderId, otherResource, agent, 5_000, 0, block.timestamp + 600, v, r, s);
        X402Gate.Receipt memory rc = gate.receiptOf(orderId);
        assertEq(rc.resourceHash, otherResource);
    }

    function test_ExpiredAuthorizationReverts() public {
        bytes32 orderId = keccak256("order-6");
        bytes32 nonce = gate.authorizationNonce(orderId);
        uint256 before_ = block.timestamp + 600;
        vm.warp(before_ + 1);
        (uint8 v, bytes32 r, bytes32 s) = _signReceive(agent, address(gate), 25_000, 0, before_, nonce);
        vm.expectRevert(MockUSD8.AuthorizationExpired.selector);
        gate.settleWithAuthorization(orderId, RESOURCE, agent, 25_000, 0, before_, v, r, s);
    }

    function _signReceive(address from, address to, uint256 value, uint256 va, uint256 vb, bytes32 nonce)
        internal view returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 typehash = keccak256(
            "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01",
            token.DOMAIN_SEPARATOR(),
            keccak256(abi.encode(typehash, from, to, value, va, vb, nonce))
        ));
        return vm.sign(agentKey, digest);
    }

    function assertTrue(bool c) internal pure { require(c, "assertTrue failed"); }
    function assertEq(uint256 a, uint256 b) internal pure { require(a == b, "assertEq uint failed"); }
    function assertEq(address a, address b) internal pure { require(a == b, "assertEq addr failed"); }
    function assertEq(bytes32 a, bytes32 b) internal pure { require(a == b, "assertEq b32 failed"); }
}
