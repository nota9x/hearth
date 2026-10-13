INSERT INTO app_settings (key, value)
VALUES ('shareSlugConfiguration', '{"defaultLength":5,"automaticFloor":3}')
ON CONFLICT(key) DO NOTHING;
