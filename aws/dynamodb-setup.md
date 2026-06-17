# AWS DynamoDB Setup

Javis uses **Amazon DynamoDB** for two high-throughput, append-only workloads:

| Workload | Why DynamoDB |
|---|---|
| Chat messages | Append-only writes; reads always scoped to one chat (partition key). Supabase Postgres would create unnecessary relational overhead for a pure key-value message stream. |
| Site analytics page-views | High-frequency write; reads always scoped to one site (partition key). No joins required. |

---

## Tables

### `javis-messages`

| Attribute | Type | Role |
|---|---|---|
| `pk` | String (PK) | `chatId` — co-locates all messages for a chat on the same partition |
| `sk` | String (SK) | `createdAt#msgId` — ISO-8601 ms prefix sorts chronologically |
| `msgId` | String | UUID of the message |
| `chatId` | String | Foreign reference to Supabase `chats.id` |
| `userId` | String | Foreign reference to Supabase auth user |
| `role` | String | `"user"` or `"assistant"` |
| `content` | String | Full message body |
| `createdAt` | String | ISO-8601 timestamp |

### `javis-analytics`

| Attribute | Type | Role |
|---|---|---|
| `pk` | String (PK) | `siteId` — co-locates all events for a site |
| `sk` | String (SK) | `createdAt#evtId` — ISO-8601 ms prefix sorts chronologically |
| `evtId` | String | UUID of the page-view event |
| `siteId` | String | Foreign reference to Supabase `sites.id` |
| `path` | String | URL path the visitor hit |
| `userAgent` | String | Visitor's user-agent string |
| `createdAt` | String | ISO-8601 timestamp |

---

## Create tables (AWS CLI)

```bash
# javis-messages
aws dynamodb create-table \
  --table-name javis-messages \
  --attribute-definitions \
      AttributeName=pk,AttributeType=S \
      AttributeName=sk,AttributeType=S \
  --key-schema \
      AttributeName=pk,KeyType=HASH \
      AttributeName=sk,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1

# javis-analytics
aws dynamodb create-table \
  --table-name javis-analytics \
  --attribute-definitions \
      AttributeName=pk,AttributeType=S \
      AttributeName=sk,AttributeType=S \
  --key-schema \
      AttributeName=pk,KeyType=HASH \
      AttributeName=sk,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1
```

Both tables use **on-demand (PAY_PER_REQUEST)** billing — no capacity planning needed.

---

## IAM permissions required

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:PutItem",
        "dynamodb:GetItem",
        "dynamodb:Query",
        "dynamodb:DeleteItem"
      ],
      "Resource": [
        "arn:aws:dynamodb:*:*:table/javis-messages",
        "arn:aws:dynamodb:*:*:table/javis-analytics"
      ]
    }
  ]
}
```

---

## Architecture diagram

```
User Browser
     │
     ▼
Vercel Edge / Serverless Functions (Next.js 15 App Router)
     │
     ├──► Supabase Auth       — session tokens, user records, RLS
     │
     ├──► Supabase Postgres   — chat metadata, tasks, sites, files metadata
     │         (structured relational data, ACID, RLS policies)
     │
     ├──► AWS DynamoDB        — chat message bodies, site page-view events
     │         (high-throughput NoSQL, partition key = chatId / siteId)
     │
     ├──► Pinecone            — 768-dim text embeddings for RAG retrieval
     │
     └──► Groq (LLM)         — llama-3.3-70b-versatile, streaming completions
```
