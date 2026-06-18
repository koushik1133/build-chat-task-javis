import { putMessage } from "./src/lib/dynamodb";

async function main() {
  try {
    await putMessage({
      msgId: "test-msg",
      chatId: "test-chat",
      userId: "test-user",
      role: "user",
      content: "Hello",
      createdAt: new Date().toISOString()
    });
    console.log("DynamoDB Success");
  } catch (e) {
    console.error("DynamoDB Error:", e);
  }
}
main();
