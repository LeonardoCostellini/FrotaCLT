-- ============================================================================
-- FrotaCTL -- Seed inicial (base vazia) para o SQL Server
-- ----------------------------------------------------------------------------
-- Uso OPCIONAL. O 01_schema.sql ja garante que a linha Id = 1 existe com um
-- JSON vazio ("{}"), e a API (ApiHandler.ashx) preenche a estrutura completa
-- sozinha na primeira gravacao feita pela tela (o proprio app cria o usuario
-- "admin" padrao no primeiro acesso, senha "admin123").
--
-- Rode este script apenas se quiser garantir explicitamente que a base comeca
-- com todas as chaves do modelo de dados ja presentes (util para conferencia
-- manual no banco antes do primeiro acesso pela tela). Pode rodar quantas
-- vezes quiser: ele sempre SUBSTITUI o conteudo da linha Id = 1.
--
-- Se voce esta migrando dados de uma instalacao anterior (outro cliente,
-- outro ambiente), NAO use este script para isso -- use, em vez disso, a
-- propria tela do sistema: Sistema > Backup & Restauracao > Importar, com o
-- arquivo .json exportado da instalacao de origem. Isso evita erros de
-- formatacao e mantém a auditoria consistente.
-- ============================================================================

USE FrotaCTL;
GO

UPDATE dbo.FrotaDB
SET Dados = N'{"companies":[],"vehicles":[],"drivers":[],"assignments":[],"fuel":[],"maintenance":[],"oil":[],"briefcases":[],"briefcaseReturns":[],"inspections":[],"schedules":[],"trips":[],"users":[],"auditLog":[],"fines":[],"briefcaseTerms":[],"briefcaseConferences":[],"tempItems":[],"tools":[],"notificationSettingsByEmpresa":{},"oilNotifications":[],"maintenanceNotifications":[],"scheduledMaintenance":[],"roleDefaults":{},"branding":null}',
    AtualizadoEm = SYSUTCDATETIME()
WHERE Id = 1;
GO

SELECT LEN(Dados) AS TamanhoJson, AtualizadoEm FROM dbo.FrotaDB WHERE Id = 1;
GO
