Simple proof of concept for sending messages using torrents.


# 1. Generate your keys (only once)
```bash
node generate-keys.js
```
# Output: Public Key: 3094be6ffec0539f21b92671cc6e6d2a6920d1b7823e34b070b9a42e61a4bd35


# 2. Share messages
```bash
node share-message.js "Hello world!"
node share-message.js "Another message"
```

# 3. Find all messages (yours or someone else's)
```bash
node find-messages.js 3094be6ffec0539f21b92671cc6e6d2a6920d1b7823e34b070b9a42e61a4bd35
```

# 4. Watch for new messages
```bash
node find-messages.js <public-key> --watch --interval=60
```
