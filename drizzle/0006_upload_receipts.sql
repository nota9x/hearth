-- Receipts are permanent: expiring/reclaiming an uncertain operation could duplicate it.
-- Only a hash of the client key and a response WITHOUT the delete secret are stored.
CREATE TABLE upload_receipts (
  key TEXT PRIMARY KEY NOT NULL,
  userId TEXT NOT NULL REFERENCES users(id),
  response TEXT
);
