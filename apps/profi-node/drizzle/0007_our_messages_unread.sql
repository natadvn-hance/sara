-- Custom SQL: on our side's messages `read` is the client's reading, which only the chat's own answer tells (whoRead,
-- 12.11.2026). The chat page stored every bubble read; ours go back to unread, and the next opening of each chat sets
-- the ones the client read, with one profi.client_read a chat the core knows.
UPDATE "node"."raw_message" SET "read" = false WHERE "author" = 'specialist' AND "read";
