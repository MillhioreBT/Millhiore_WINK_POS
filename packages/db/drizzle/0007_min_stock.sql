-- Escrita a mano: drizzle-kit recrea la tabla para añadir un CHECK, y basta con ADD COLUMN.
ALTER TABLE `variant` ADD `min_stock_milli` integer CONSTRAINT "variant_min_stock_nonneg" CHECK(`min_stock_milli` is null or `min_stock_milli` >= 0);
