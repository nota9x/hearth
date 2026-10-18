ALTER TABLE users ADD COLUMN displayNamePolicy text NOT NULL DEFAULT 'inherit' CONSTRAINT valid_display_name_policy CHECK(displayNamePolicy IN ('inherit','allow','restrict'));
