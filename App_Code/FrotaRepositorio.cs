// ============================================================================
// FrotaRepositorio.cs
// ----------------------------------------------------------------------------
// Acesso centralizado aos dados do FrotaCTL no SQL Server Express.
//
// Toda a base continua sendo um único documento JSON (companies, vehicles,
// drivers, etc.) — exatamente como era gravado em data/frotactl.json — só que
// agora esse JSON mora em uma única linha (Id = 1) da tabela dbo.FrotaDB, em
// vez de um arquivo em disco. O restante do sistema (app.js, telas, lógica de
// negócio) não muda em nada: continua lendo/gravando "o banco inteiro" de uma
// vez, do jeito que já funciona hoje.
//
// Usado por: ApiHandler.ashx e OilAlerts.ashx.
//
// Pré-requisito: connection string "FrotaCTL" definida em web.config
// (<connectionStrings><add name="FrotaCTL" .../></connectionStrings>).
// Ver MANUAL.md para o passo a passo completo (criar o banco, rodar o
// schema, importar os dados atuais e configurar a connection string).
// ============================================================================

using System;
using System.Configuration;
using System.Data;
using System.Data.SqlClient;

public static class FrotaRepositorio
{
    private const string ConnName = "FrotaCTL";

    private static string ConnStr()
    {
        var cs = ConfigurationManager.ConnectionStrings[ConnName];
        if (cs == null || string.IsNullOrWhiteSpace(cs.ConnectionString))
            throw new Exception(
                "Connection string '" + ConnName + "' nao encontrada (ou vazia) em web.config. " +
                "Veja MANUAL.md.");
        return cs.ConnectionString;
    }

    /// <summary>
    /// Lê o JSON completo da base (a mesma estrutura que antes vinha do
    /// arquivo data/frotactl.json). Se a linha ainda não existir, devolve "[]"
    /// (equivalente ao antigo comportamento de "arquivo ainda não criado").
    /// </summary>
    public static string LerDados()
    {
        using (var conn = new SqlConnection(ConnStr()))
        using (var cmd = new SqlCommand("SELECT Dados FROM dbo.FrotaDB WHERE Id = 1", conn))
        {
            conn.Open();
            object result = cmd.ExecuteScalar();
            if (result == null || result == DBNull.Value)
                return "[]";
            return (string)result;
        }
    }

    /// <summary>
    /// Grava (upsert) o JSON completo da base na linha Id = 1, substituindo
    /// tudo — igual ao comportamento atual de sobrescrever o arquivo inteiro.
    /// Usa parâmetro NVARCHAR(MAX), então nunca há truncamento nem problema
    /// de aspas/acentos no conteúdo.
    /// </summary>
    public static void GravarDados(string json)
    {
        const string sql = @"
IF EXISTS (SELECT 1 FROM dbo.FrotaDB WHERE Id = 1)
    UPDATE dbo.FrotaDB SET Dados = @Dados, AtualizadoEm = SYSUTCDATETIME() WHERE Id = 1;
ELSE
    INSERT INTO dbo.FrotaDB (Id, Dados, AtualizadoEm) VALUES (1, @Dados, SYSUTCDATETIME());";

        using (var conn = new SqlConnection(ConnStr()))
        using (var cmd = new SqlCommand(sql, conn))
        {
            var param = cmd.Parameters.Add("@Dados", SqlDbType.NVarChar, -1); // -1 = MAX, sem limite de tamanho
            param.Value = json;
            conn.Open();
            cmd.ExecuteNonQuery();
        }
    }
}
