-- ============================================================================
-- FrotaCTL — Schema do banco de dados (SQL Server Express 2025)
-- ----------------------------------------------------------------------------
-- Cria o banco "FrotaCTL" e a tabela dbo.FrotaDB, que guarda todo o conteúdo
-- do sistema em uma única linha (Id = 1), no formato JSON — exatamente o
-- mesmo conteúdo que hoje está em data/frotactl.json.
--
-- Por quê assim (e não uma tabela por cadastro)?
--   O front-end (app.js) já funciona lendo/gravando "o banco inteiro" de uma
--   vez só. Guardar o mesmo JSON em uma coluna NVARCHAR(MAX) elimina o
--   arquivo .txt/.json gigante em disco, dá leitura muito rápida (é 1 linha
--   buscada pela chave primária, o SQL Server mantém isso em memória) e não
--   exige NENHUMA mudança na tela — logo, nenhum risco novo ao cadastrar
--   coisas pela interface.
--
-- Como rodar: abra este arquivo no SQL Server Management Studio (SSMS) ou
-- Azure Data Studio, conectado à instância do SQL Express, e execute tudo
-- (F5). Pode rodar quantas vezes quiser — os comandos são "IF NOT EXISTS".
-- ============================================================================

IF DB_ID(N'FrotaCTL') IS NULL
BEGIN
    CREATE DATABASE FrotaCTL;
END
GO

USE FrotaCTL;
GO

IF OBJECT_ID(N'dbo.FrotaDB', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.FrotaDB
    (
        Id           INT            NOT NULL CONSTRAINT PK_FrotaDB PRIMARY KEY,
        Dados        NVARCHAR(MAX)  NOT NULL,
        AtualizadoEm DATETIME2      NOT NULL CONSTRAINT DF_FrotaDB_AtualizadoEm DEFAULT SYSUTCDATETIME()
    );
END
GO

-- Garante que exista a linha Id = 1 (vazia). O script 02_migrar_dados_atuais.sql
-- substitui o conteúdo dela pelos dados reais que já existem em
-- data/frotactl.json. Se você estiver criando o sistema do zero (sem dados
-- antigos), pode pular o script 02 e deixar como está: a API cria/atualiza
-- essa linha sozinha na primeira gravação.
IF NOT EXISTS (SELECT 1 FROM dbo.FrotaDB WHERE Id = 1)
BEGIN
    INSERT INTO dbo.FrotaDB (Id, Dados) VALUES (1, N'{}');
END
GO

-- ============================================================================
-- Permissões — o "pool de aplicativos" do IIS precisa conseguir ler/gravar
-- nessa tabela. Escolha UMA das opções abaixo.
-- ============================================================================

-- OPÇÃO A) Autenticação do Windows (recomendada — sem senha no web.config).
-- Troque 'IIS APPPOOL\NomeDoSitePool' pelo nome real do seu Application Pool
-- no IIS (Gerenciador do IIS → Pools de Aplicativos). Ex.: se o pool se chama
-- "FrotaCTL", o login é 'IIS APPPOOL\FrotaCTL'.
/*
CREATE LOGIN [IIS APPPOOL\NomeDoSitePool] FROM WINDOWS;
USE FrotaCTL;
CREATE USER [IIS APPPOOL\NomeDoSitePool] FOR LOGIN [IIS APPPOOL\NomeDoSitePool];
GRANT SELECT, INSERT, UPDATE ON dbo.FrotaDB TO [IIS APPPOOL\NomeDoSitePool];
*/

-- OPÇÃO B) Autenticação SQL (usuário/senha, se preferir não usar Windows Auth).
/*
CREATE LOGIN frotactl_app WITH PASSWORD = 'TrocarPorUmaSenhaForte!123';
USE FrotaCTL;
CREATE USER frotactl_app FOR LOGIN frotactl_app;
GRANT SELECT, INSERT, UPDATE ON dbo.FrotaDB TO frotactl_app;
*/
