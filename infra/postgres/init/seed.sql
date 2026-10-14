CREATE ROLE wagering_owner LOGIN CREATEDB PASSWORD 'wagering_owner_dev';
CREATE ROLE wagering_app LOGIN PASSWORD 'wagering_app_dev';

ALTER DATABASE wagering OWNER TO wagering_owner;
REVOKE ALL ON DATABASE wagering FROM PUBLIC;
GRANT CONNECT ON DATABASE wagering TO wagering_app;
GRANT USAGE ON SCHEMA public TO wagering_app;

ALTER DEFAULT PRIVILEGES FOR ROLE wagering_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO wagering_app;
ALTER DEFAULT PRIVILEGES FOR ROLE wagering_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO wagering_app;