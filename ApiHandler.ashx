<%@ WebHandler Language="C#" Class="ApiHandler" %>

using System;
using System.IO;
using System.Text;
using System.Web;

public class ApiHandler : IHttpHandler
{
    // ── IHttpHandler ─────────────────────────────────────────────────────────

    public bool IsReusable { get { return false; } }

    public void ProcessRequest(HttpContext ctx)
    {
        HttpRequest  req = ctx.Request;
        HttpResponse res = ctx.Response;

        res.ContentType     = "application/json; charset=utf-8";
        res.ContentEncoding = Encoding.UTF8;

        res.AppendHeader("Access-Control-Allow-Origin",  "*");
        res.AppendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.AppendHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.HttpMethod == "OPTIONS")
        {
            res.StatusCode = 204;
            return;
        }

        try
        {
            if (req.HttpMethod == "GET")
            {
                HandleGet(ctx);
            }
            else if (req.HttpMethod == "POST")
            {
                HandlePost(ctx);
            }
            else
            {
                res.StatusCode = 405;
                res.Write("{\"success\":false,\"error\":\"Metodo nao permitido.\"}");
            }
        }
        catch (Exception ex)
        {
            res.StatusCode = 500;
            string msg = ex.Message.Replace("\\", "\\\\").Replace("\"", "\\\"");
            res.Write("{\"success\":false,\"error\":\"" + msg + "\"}");
        }
    }

    // ── GET ──────────────────────────────────────────────────────────────────

    private void HandleGet(HttpContext ctx)
    {
        string json = FrotaRepositorio.LerDados();
        ctx.Response.Write("{\"success\":true,\"data\":" + json + "}");
    }

    // ── POST ─────────────────────────────────────────────────────────────────

    private void HandlePost(HttpContext ctx)
    {
        string body;
        using (StreamReader reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8))
        {
            body = reader.ReadToEnd();
        }

        if (string.IsNullOrEmpty(body) || body.Trim().Length == 0)
        {
            ctx.Response.StatusCode = 400;
            ctx.Response.Write("{\"success\":false,\"error\":\"Body vazio.\"}");
            return;
        }

        string trimmed = body.TrimStart();
        if (!trimmed.StartsWith("[") && !trimmed.StartsWith("{"))
        {
            ctx.Response.StatusCode = 400;
            ctx.Response.Write("{\"success\":false,\"error\":\"JSON invalido.\"}");
            return;
        }

        // PONTO DE MIGRAÇÃO (concluído): os dados agora ficam no SQL Server
        // (tabela dbo.FrotaDB), não mais em data/frotactl.json.
        // Acesso centralizado em App_Code/FrotaRepositorio.cs.
        FrotaRepositorio.GravarDados(body);
        ctx.Response.Write("{\"success\":true}");
    }
}
