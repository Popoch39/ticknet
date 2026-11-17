# ticknet

ticknet is a transport library for real-time multiplayer games: it carries a game's own data between a Server and its Clients over an unreliable network, and nothing more.

## Endpoints

**Server**:
The single authoritative endpoint that Clients connect to and that runs the game's Tick.
_Avoid_: Host, peer

**Client**:
An endpoint that connects to one Server on behalf of one game instance.
_Avoid_: Peer, player

**Connection**:
The relationship between the Server and one Client, from the end of a successful Handshake until it closes for a stated reason. Reconnecting always makes a new Connection.
_Avoid_: Session, peer, player, socket

**Handshake**:
The exchange through which a Client asks for a Connection and the Server proves the Client's address and decides whether to accept it.
_Avoid_: Login, connect sequence

**Auth token**:
Opaque bytes a Client presents during the Handshake so the game can decide whether to admit it; ticknet never interprets them.
_Avoid_: Password, credentials, ticket

**Transport**:
The means by which Datagrams leave and reach an endpoint, such as a UDP socket or a simulated network.
_Avoid_: Socket, driver, channel

## Data

**Datagram**:
One self-contained unit of bytes sent across the network, which may be lost, duplicated or reordered on the way.
_Avoid_: Packet, frame

**Message**:
A typed value defined by the game and exchanged between Server and Client; the unit the game sends and receives.
_Avoid_: Packet, event, command, payload

**Fragment**:
One piece of a Reliable Message too large to fit in a single Datagram.
_Avoid_: Chunk, part, segment

## Delivery

**Delivery mode**:
The guarantee the game chooses for each Message it sends: Unreliable, Sequenced or Reliable.
_Avoid_: Channel, QoS, reliability level

**Unreliable**:
The Delivery mode in which a Message may be lost and may arrive out of order, but is never delivered twice.
_Avoid_: Fire-and-forget, best effort

**Sequenced**:
The Delivery mode in which a Message may be lost, but one older than the latest delivered of its type is discarded rather than delivered.
_Avoid_: Ordered, latest-only

**Reliable**:
The Delivery mode in which every Message arrives exactly once and in the order it was sent.
_Avoid_: Guaranteed, ordered, TCP-like

## Time and limits

**Tick**:
One step of the fixed-rate loop the library runs, numbered from the start; everything sent during a Tick leaves together.
_Avoid_: Frame, step, update

**Send step**:
One beat of a Client's send rate, at which everything the Client sent since the previous one leaves together; the Client's counterpart of the Server's Tick.
_Avoid_: Client tick, flush

**Send budget**:
The amount of data a Connection may send during one Tick, or one Send step on the Client's side.
_Avoid_: Bandwidth, rate limit, quota
