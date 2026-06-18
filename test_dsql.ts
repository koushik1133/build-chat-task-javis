import { queryOne } from "./src/lib/dsql";

async function main() {
  try {
    const row = await queryOne(
      "INSERT INTO chats (user_id, title) VALUES ($1, $2) RETURNING id",
      ["test_user", "test title"]
    );
    console.log("Success:", row);
  } catch (e) {
    console.error("Error thrown by queryOne:", e);
  }
}
main();
