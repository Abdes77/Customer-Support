-- C11: a Microsoft Graph change-notification subscription names exactly one email connection.
CREATE UNIQUE INDEX "channel_connections_subscription_key" ON "channel_connections" USING btree ("channel",("state" ->> 'subscriptionId')) WHERE ("channel_connections"."state" ->> 'subscriptionId') is not null;
