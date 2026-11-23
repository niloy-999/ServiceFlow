CREATE DATABASE serviceflow_dev OWNER serviceflow_migrator;
CREATE DATABASE serviceflow_test OWNER serviceflow_migrator;
CREATE DATABASE serviceflow_shadow OWNER serviceflow_migrator;
REVOKE ALL ON DATABASE serviceflow_bootstrap FROM PUBLIC;
REVOKE ALL ON DATABASE serviceflow_dev FROM PUBLIC;
REVOKE ALL ON DATABASE serviceflow_test FROM PUBLIC;
REVOKE ALL ON DATABASE serviceflow_shadow FROM PUBLIC;
REVOKE ALL ON DATABASE serviceflow_shadow FROM serviceflow_app;

GRANT CONNECT ON DATABASE serviceflow_dev TO serviceflow_app;
GRANT CONNECT ON DATABASE serviceflow_test TO serviceflow_app;
