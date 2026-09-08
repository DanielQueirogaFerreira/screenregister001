-- Roles and permissions, held in the database.
--
-- Operator access used to come only from the ADMIN_EMAILS Worker secret, and the argument
-- for that was real: a role in a table is one careless UPDATE, one injection, or one
-- restored backup away from belonging to the wrong person, while a Worker secret takes
-- access to the Cloudflare account to change. That argument does not go away here. What
-- changes is that operators must be managed from inside the product, and a permission
-- model that can only be edited by redeploying is not a permission model.
--
-- So the two are combined rather than swapped. ADMIN_EMAILS keeps one job — seeding the
-- first master when there is none, and acting as the way back in if the master account is
-- ever lost. Everything after that is these columns.
--
-- Three roles, and the distance between them is deliberate:
--
--   user    their own recordings, and nothing else
--   admin   whatever their permission flags say
--   master  everything, and untouchable by anyone but themselves
--
-- The master exists because "admins can add admins" and "no admin can lock me out of my
-- own system" are both required, and only a rank above the one that can be granted
-- satisfies both.

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';

-- Permissions, one column each rather than a JSON blob, so a query can ask who holds one
-- and a typo in a key name cannot silently grant nothing — or silently grant everything.
-- All default to off: a new admin starts able to see the operator view and do nothing in
-- it, which is the right direction for a mistake to fall.
ALTER TABLE users ADD COLUMN can_manage_users      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN can_grant_admin       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN can_view_frames       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN can_delete_recordings INTEGER NOT NULL DEFAULT 0;

-- Soft delete. A removed account's recordings can be kept, and frames carry a user_id, so
-- deleting the row outright would leave them owned by nobody — attributable to an id with
-- no name behind it, which is worse than useless in an audit. The row stays, its
-- credentials are destroyed and its sessions revoked; only the ability to sign in ends.
ALTER TABLE users ADD COLUMN deleted_at TEXT;
ALTER TABLE users ADD COLUMN deleted_by TEXT;

-- At most one master, enforced by the database rather than by the care of every code path
-- that might promote someone. A partial index is the only way SQLite expresses "unique
-- among the rows that matter", and transferring the role therefore has to demote before it
-- promotes — which is exactly the ordering that cannot leave two masters behind.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_one_master ON users(role) WHERE role = 'master';

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
