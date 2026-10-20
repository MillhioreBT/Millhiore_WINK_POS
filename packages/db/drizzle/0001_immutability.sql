-- Los documentos contabilizados y sus movimientos son inmutables: un error se corrige con un
-- documento de reverso, nunca con UPDATE ni DELETE. Se impone en la base, no solo en el código.
CREATE TRIGGER document_no_update BEFORE UPDATE ON document
BEGIN SELECT RAISE(ABORT, 'document es inmutable: use un documento de reverso'); END;
--> statement-breakpoint
CREATE TRIGGER document_no_delete BEFORE DELETE ON document
BEGIN SELECT RAISE(ABORT, 'document es inmutable: use un documento de reverso'); END;
--> statement-breakpoint
CREATE TRIGGER document_line_no_update BEFORE UPDATE ON document_line
BEGIN SELECT RAISE(ABORT, 'document_line es inmutable: use un documento de reverso'); END;
--> statement-breakpoint
CREATE TRIGGER document_line_no_delete BEFORE DELETE ON document_line
BEGIN SELECT RAISE(ABORT, 'document_line es inmutable: use un documento de reverso'); END;
--> statement-breakpoint
CREATE TRIGGER payment_no_update BEFORE UPDATE ON payment
BEGIN SELECT RAISE(ABORT, 'payment es inmutable: use un documento de reverso'); END;
--> statement-breakpoint
CREATE TRIGGER payment_no_delete BEFORE DELETE ON payment
BEGIN SELECT RAISE(ABORT, 'payment es inmutable: use un documento de reverso'); END;
--> statement-breakpoint
CREATE TRIGGER stock_move_no_update BEFORE UPDATE ON stock_move
BEGIN SELECT RAISE(ABORT, 'stock_move es inmutable: use un documento de reverso'); END;
--> statement-breakpoint
CREATE TRIGGER stock_move_no_delete BEFORE DELETE ON stock_move
BEGIN SELECT RAISE(ABORT, 'stock_move es inmutable: use un documento de reverso'); END;
--> statement-breakpoint
CREATE TRIGGER account_move_no_update BEFORE UPDATE ON account_move
BEGIN SELECT RAISE(ABORT, 'account_move es inmutable: use un documento de reverso'); END;
--> statement-breakpoint
CREATE TRIGGER account_move_no_delete BEFORE DELETE ON account_move
BEGIN SELECT RAISE(ABORT, 'account_move es inmutable: use un documento de reverso'); END;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log es inmutable: use un documento de reverso'); END;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log es inmutable: use un documento de reverso'); END;
