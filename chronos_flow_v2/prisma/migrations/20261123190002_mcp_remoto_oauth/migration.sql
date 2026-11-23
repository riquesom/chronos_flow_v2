-- AlterTable
ALTER TABLE "api_tokens" ADD COLUMN     "cliente_oauth" TEXT;

-- CreateTable
CREATE TABLE "oauth_clientes" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "redirect_uris" TEXT[],
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_clientes_pkey" PRIMARY KEY ("id")
);

