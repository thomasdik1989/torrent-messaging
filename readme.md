# Torrent Messaging

A simple proof of concept for sending messages using torrents. Share only your public key - others can find and download all your messages.

## How It Works

```mermaid
flowchart TB
    subgraph users [Users]
        Biggs[Biggs<br/>Publisher]
        Wedge[Wedge<br/>Subscriber]
    end

    subgraph server [Signaling Server]
        DB[(Phone Book<br/>Public Key → Infohash)]
    end

    subgraph torrent [Torrent Network]
        T1[Manifest Torrent]
        T2[Message Torrents]
    end

    Biggs -->|1. Announce| DB
    Biggs -->|2. Seed| T1
    Biggs -->|2. Seed| T2

    Wedge -->|3. Lookup by Public Key| DB
    DB -->|4. Return Infohash| Wedge
    Wedge -->|5. Download| T1
    Wedge -->|6. Download| T2
```

### Message Sharing Flow

```mermaid
sequenceDiagram
    participant A as Biggs (Publisher)
    participant S as Signaling Server
    participant T as Torrent Network

    Note over A: Creates message & signs it
    A->>T: Seed message as torrent
    T-->>A: Message infohash

    Note over A: Updates manifest with new message
    A->>T: Seed manifest as torrent
    T-->>A: Manifest infohash

    A->>S: Announce (public key, manifest infohash, signature)
    S->>S: Verify signature
    S-->>A: OK

    Note over A: Keeps seeding...
```

### Message Finding Flow

```mermaid
sequenceDiagram
    participant B as Wedge (Subscriber)
    participant S as Signaling Server
    participant T as Torrent Network

    B->>S: Lookup (Biggs's public key)
    S-->>B: Manifest infohash

    B->>T: Download manifest
    T-->>B: Manifest (list of message infohashes)

    Note over B: Verifies manifest signature

    loop For each message
        B->>T: Download message
        T-->>B: Message content
        Note over B: Verifies message signature
    end
```

### Data Structure

```mermaid
flowchart LR
    subgraph server [Server Storage ~68 bytes/user]
        PK[Public Key<br/>64 chars] --> IH[Manifest Infohash<br/>40 chars]
        IH --> SEQ[Sequence #]
    end

    subgraph manifest [Manifest Torrent]
        M[List of Messages]
        M --> M1[infohash 1 + timestamp]
        M --> M2[infohash 2 + timestamp]
        M --> M3[infohash N + timestamp]
    end

    subgraph messages [Message Torrents]
        MSG[Each Message]
        MSG --> C[Content]
        MSG --> TS[Timestamp]
        MSG --> SIG[Signature]
    end
```

## Key Points

| Component | Role | Data Stored |
|-----------|------|-------------|
| **Signaling Server** | Phone book | Public key → latest manifest infohash |
| **Torrent Network** | File transfer | Actual messages (decentralized) |
| **Publisher** | Seeds torrents | Must stay online to serve files |
| **Subscriber** | Downloads | Only needs the public key |

The server is lightweight (~68 bytes per user) - it just points to where the data is. The actual messages flow peer-to-peer via torrents.

## Quick Start

### 1. Start the signaling server

```bash
node server.js
# Or on a custom port:
PORT=3001 node server.js
```

### 2. Generate your keys (only once)

```bash
node generate-keys.js
```

Output: `Public Key: 3094be6ffec0539f21b92671cc6e6d2a6920d1b7823e34b070b9a42e61a4bd35`

### 3. Share messages

```bash
SERVER_URL=http://localhost:3001 node share-message.js "Your message"
```

Keep this process running to seed the torrents.

### 4. Find messages by public key

```bash
SERVER_URL=http://localhost:3001 node find-messages.js <public-key>
```

### 5. Watch for new messages

```bash
SERVER_URL=http://localhost:3001 node find-messages.js <public-key> --watch --interval=60
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_URL` | `http://localhost:3000` | Signaling server URL |
| `PORT` | `3000` | Server listening port |

## Server Capacity

For 1 million users:
- Storage: ~65-200 MB
- RAM: Can fit entire DB in memory
- CPU: Minimal (simple key-value lookups)

A $5/month VPS or even a Raspberry Pi can handle this easily.
