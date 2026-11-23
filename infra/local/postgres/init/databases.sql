CREATE DATABASE serviceflow_dev OWNER serviceflow_migrator;
CREATE DATABASE serviceflow_test OWNER serviceflow_migrator;
CREATE DATABASE serviceflow_shadow OWNER serviceflow_migrator;
GRANT CONNECT ON DATABASE serviceflow_dev TO serviceflow_app;
GRANT CONNECT ON DATABASE serviceflow_test TO serviceflow_app;
GRANT CONNECT ON DATABASE serviceflow_shadow TO serviceflow_app;
