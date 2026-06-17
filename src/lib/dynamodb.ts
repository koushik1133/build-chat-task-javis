import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

// DynamoDB is used for two high-throughput workloads:
//   1. Chat messages  — append-only, read by chat, ideal NoSQL pattern
//   2. Site analytics — time-series page-view events
//
// All structured metadata (chats, tasks, sites, files, users) remains in
// Supabase Postgres (relational consistency, RLS).
// Vector embeddings stay in Pinecone.
//
// Table: javis-messages
//   PK  = chatId          (partition key – all messages for a chat co-located)
//   SK  = createdAt#msgId (sort key – millisecond ISO string + random suffix)
//   Attributes: msgId, userId, role, content, createdAt
//
// Table: javis-analytics
//   PK  = siteId          (partition key)
//   SK  = createdAt#evtId (sort key)
//   Attributes: evtId, siteId, path, userAgent, createdAt

function makeDdbClient() {
  const region = process.env.AWS_REGION ?? "us-east-1";
  const cfg: ConstructorParameters<typeof DynamoDBClient>[0] = { region };

  const key = process.env.AWS_ACCESS_KEY_ID;
  const secret = process.env.AWS_SECRET_ACCESS_KEY;
  if (key && secret) {
    cfg.credentials = { accessKeyId: key, secretAccessKey: secret };
  }
  // If running in a Lambda / ECS task the SDK will pick up the task role automatically.

  return DynamoDBDocumentClient.from(new DynamoDBClient(cfg), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

let _client: DynamoDBDocumentClient | null = null;
function ddb() {
  if (!_client) _client = makeDdbClient();
  return _client;
}

export const MESSAGES_TABLE = process.env.DYNAMODB_MESSAGES_TABLE ?? "javis-messages";
export const ANALYTICS_TABLE = process.env.DYNAMODB_ANALYTICS_TABLE ?? "javis-analytics";

// ─── Chat Messages ────────────────────────────────────────────────────────────

export type DdbMessage = {
  msgId: string;
  chatId: string;
  userId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

/**
 * Write one message to DynamoDB.
 * SK format: ISO8601ms#msgId  (lexicographic = chronological order)
 */
export async function putMessage(msg: DdbMessage) {
  const sk = `${msg.createdAt}#${msg.msgId}`;
  await ddb().send(
    new PutCommand({
      TableName: MESSAGES_TABLE,
      Item: { pk: msg.chatId, sk, ...msg },
    })
  );
}

/**
 * Read up to `limit` most-recent messages for a chat, oldest first.
 */
export async function getMessages(
  chatId: string,
  limit = 50
): Promise<DdbMessage[]> {
  const res = await ddb().send(
    new QueryCommand({
      TableName: MESSAGES_TABLE,
      KeyConditionExpression: "pk = :chatId",
      ExpressionAttributeValues: { ":chatId": chatId },
      ScanIndexForward: false, // newest first
      Limit: limit,
    })
  );
  const items = (res.Items ?? []) as (DdbMessage & { pk: string; sk: string })[];
  return items
    .map((item) => {
      const rest = { ...item } as Partial<DdbMessage> & { pk?: string; sk?: string };
      delete rest.pk;
      delete rest.sk;
      return rest as DdbMessage;
    })
    .reverse(); // return oldest first
}

/**
 * Delete all messages for a chat (called when a chat is deleted).
 */
export async function deleteMessages(chatId: string) {
  const res = await ddb().send(
    new QueryCommand({
      TableName: MESSAGES_TABLE,
      KeyConditionExpression: "pk = :chatId",
      ExpressionAttributeValues: { ":chatId": chatId },
      ProjectionExpression: "pk, sk",
    })
  );
  const items = res.Items ?? [];
  await Promise.all(
    items.map((item) =>
      ddb().send(
        new DeleteCommand({
          TableName: MESSAGES_TABLE,
          Key: { pk: item.pk, sk: item.sk },
        })
      )
    )
  );
}

// ─── Site Analytics ───────────────────────────────────────────────────────────

export type DdbPageView = {
  evtId: string;
  siteId: string;
  path: string;
  userAgent: string;
  createdAt: string;
};

/**
 * Record a page view event for a published site.
 */
export async function putPageView(ev: DdbPageView) {
  const sk = `${ev.createdAt}#${ev.evtId}`;
  await ddb().send(
    new PutCommand({
      TableName: ANALYTICS_TABLE,
      Item: { pk: ev.siteId, sk, ...ev },
    })
  );
}

/**
 * Fetch up to `limit` most-recent page views for a site, newest first.
 */
export async function getPageViews(
  siteId: string,
  limit = 200
): Promise<DdbPageView[]> {
  const res = await ddb().send(
    new QueryCommand({
      TableName: ANALYTICS_TABLE,
      KeyConditionExpression: "pk = :siteId",
      ExpressionAttributeValues: { ":siteId": siteId },
      ScanIndexForward: false,
      Limit: limit,
    })
  );
  const items = (res.Items ?? []) as (DdbPageView & { pk: string; sk: string })[];
  return items.map((item) => {
    const rest = { ...item } as Partial<DdbPageView> & { pk?: string; sk?: string };
    delete rest.pk;
    delete rest.sk;
    return rest as DdbPageView;
  });
}
