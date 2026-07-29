<%@ WebHandler Language="C#" Class="MaintenanceAlerts" %>
<%@ Assembly Name="System.Web.Extensions" %>

// ============================================================================
// MaintenanceAlerts.ashx
// ----------------------------------------------------------------------------
// Verifica todas as manutenções PROGRAMADAS (aba "Programadas", status
// diferente de "concluida") e, para as que estão próximas ou vencidas (por
// KM ou por DATA prevista, conforme configurado em notificationSettingsByEmpresa),
// envia um SMS ao celular do gestor cadastrado (o mesmo número usado para os
// avisos de troca de óleo), usando a API do Twilio.
//
// Diferente de OilAlerts (que olha o registro mais recente de troca), este
// handler nunca considera manutenções já REGISTRADAS/concluídas — só as que
// estão pendentes na aba "Programadas". Registrar uma manutenção já feita
// nunca deve gerar aviso.
//
// USO:
//   GET MaintenanceAlerts.ashx            -> roda a verificação normal
//                                             (chamado 1x/dia por uma Tarefa
//                                             Agendada do Windows, junto com OilAlerts.ashx)
//   GET MaintenanceAlerts.ashx?test=1&phone=5543999998888  -> envia SMS de teste
//
// Ver MANUAL.md para o passo a passo de configuração (Twilio + agendamento).
// ============================================================================

using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Configuration;
using System.IO;
using System.Net;
using System.Text;
using System.Web;
using System.Web.Script.Serialization;

public class MaintenanceAlerts : IHttpHandler
{
    public bool IsReusable { get { return false; } }

    public void ProcessRequest(HttpContext ctx)
    {
        HttpResponse res = ctx.Response;
        res.ContentType     = "application/json; charset=utf-8";
        res.ContentEncoding = Encoding.UTF8;

        try
        {
            // ── Chave de segurança opcional (recomendado se o servidor for público) ──
            string requiredKey = ConfigurationManager.AppSettings["NotifSecret"];
            if (!string.IsNullOrWhiteSpace(requiredKey))
            {
                string providedKey = ctx.Request.QueryString["key"];
                if (providedKey != requiredKey)
                {
                    res.StatusCode = 401;
                    res.Write("{\"success\":false,\"error\":\"Chave de seguranca invalida ou ausente.\"}");
                    return;
                }
            }

            var serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = Int32.MaxValue;

            // ── Modo de teste: envia uma mensagem simples sem checar manutenções ──
            if (ctx.Request.QueryString["test"] == "1")
            {
                string testPhone = ctx.Request.QueryString["phone"];
                if (string.IsNullOrWhiteSpace(testPhone))
                {
                    res.Write("{\"success\":false,\"error\":\"Telefone nao informado.\"}");
                    return;
                }
                string testMsg = "FrotaCTL: mensagem de teste. Os avisos de manutencao programada estao funcionando corretamente.";
                string testErr;
                bool testOk = SendSms(testPhone, testMsg, out testErr);
                res.Write(testOk
                    ? "{\"success\":true}"
                    : "{\"success\":false,\"error\":\"" + Escape(testErr) + "\"}");
                return;
            }

            // ── Verificação normal ──
            string json = FrotaRepositorio.LerDados();
            if (string.IsNullOrWhiteSpace(json) || !json.TrimStart().StartsWith("{"))
            {
                res.Write("{\"success\":false,\"error\":\"Registro de dados nao encontrado no banco (dbo.FrotaDB).\"}");
                return;
            }

            Dictionary<string, object> db = (Dictionary<string, object>)serializer.DeserializeObject(json);

            Dictionary<string, object> settingsByEmpresa = GetDict(db, "notificationSettingsByEmpresa");
            ArrayList companies   = GetList(db, "companies");
            ArrayList vehicles    = GetList(db, "vehicles");
            ArrayList schedules   = GetList(db, "scheduledMaintenance");
            ArrayList log         = GetList(db, "maintenanceNotifications");
            if (log == null) { log = new ArrayList(); db["maintenanceNotifications"] = log; }

            HashSet<string> alreadyNotified = new HashSet<string>();
            foreach (object o in log)
            {
                Dictionary<string, object> n = o as Dictionary<string, object>;
                if (n != null && n.ContainsKey("key"))
                    alreadyNotified.Add(Convert.ToString(n["key"]));
            }

            int sentCount = 0;
            int errorCount = 0;
            DateTime today = DateTime.Today;

            if (companies != null && settingsByEmpresa != null && vehicles != null && schedules != null)
            {
                foreach (object co in companies)
                {
                    Dictionary<string, object> company = co as Dictionary<string, object>;
                    if (company == null || !company.ContainsKey("id")) continue;
                    string empresaId = Convert.ToString(company["id"]);

                    Dictionary<string, object> settings = GetDict(settingsByEmpresa, empresaId);
                    bool enabled = settings != null && settings.ContainsKey("enabled") && Convert.ToBoolean(settings["enabled"]);
                    string phone = settings != null && settings.ContainsKey("managerPhone") ? Convert.ToString(settings["managerPhone"]) : null;
                    if (!enabled || string.IsNullOrWhiteSpace(phone)) continue; // empresa sem notificacoes ativas

                    double daysBefore = settings.ContainsKey("daysBefore") ? Convert.ToDouble(settings["daysBefore"]) : 7;
                    double kmBefore   = settings.ContainsKey("kmBefore")   ? Convert.ToDouble(settings["kmBefore"])   : 500;

                    // Mapa rápido de veículos desta empresa (id -> km atual / placa)
                    Dictionary<string, Dictionary<string, object>> vehicleById = new Dictionary<string, Dictionary<string, object>>();
                    foreach (object vo in vehicles)
                    {
                        Dictionary<string, object> v = vo as Dictionary<string, object>;
                        if (v == null || !v.ContainsKey("id")) continue;
                        if (!v.ContainsKey("empresaId") || Convert.ToString(v["empresaId"]) != empresaId) continue;
                        vehicleById[Convert.ToString(v["id"])] = v;
                    }

                    foreach (object so in schedules)
                    {
                        Dictionary<string, object> s = so as Dictionary<string, object>;
                        if (s == null || !s.ContainsKey("id")) continue;
                        if (!s.ContainsKey("empresaId") || Convert.ToString(s["empresaId"]) != empresaId) continue;

                        string status = s.ContainsKey("status") ? Convert.ToString(s["status"]) : "pendente";
                        if (status == "concluida") continue; // já realizada, não é mais um aviso a disparar

                        string vehicleId = s.ContainsKey("vehicleId") ? Convert.ToString(s["vehicleId"]) : null;
                        if (vehicleId == null || !vehicleById.ContainsKey(vehicleId)) continue;
                        Dictionary<string, object> v = vehicleById[vehicleId];
                        string plate = v.ContainsKey("plate") ? Convert.ToString(v["plate"]) : "(sem placa)";
                        double km    = v.ContainsKey("km") ? Convert.ToDouble(v["km"]) : 0;

                        bool hasDueKm = s.ContainsKey("dueKm") && Convert.ToDouble(s["dueKm"]) > 0;
                        double dueKm  = hasDueKm ? Convert.ToDouble(s["dueKm"]) : 0;

                        DateTime dueDate;
                        bool hasDueDate = s.ContainsKey("dueDate") &&
                            DateTime.TryParse(Convert.ToString(s["dueDate"]), out dueDate);
                        if (!hasDueDate) dueDate = DateTime.MinValue;

                        double kmRemaining   = hasDueKm ? dueKm - km : double.MaxValue;
                        double daysRemaining = hasDueDate ? (dueDate - today).TotalDays : double.MaxValue;

                        string reason = null;
                        if ((hasDueKm && kmRemaining <= 0) || (hasDueDate && daysRemaining <= 0)) reason = "vencida";
                        else if (hasDueKm && kmRemaining <= kmBefore) reason = "km";
                        else if (hasDueDate && daysRemaining <= daysBefore) reason = "data";

                        if (reason == null) continue; // ainda longe da manutenção

                        string scheduleId = Convert.ToString(s["id"]);
                        string key = scheduleId + ":" + reason;
                        // Para "data", inclui o dia no key para reenviar tanto no aviso de "7 dias antes" quanto no "dia" (chaves diferentes)
                        if (reason == "data") key = key + ":" + ((int)Math.Ceiling(Math.Max(0, daysRemaining)));
                        if (alreadyNotified.Contains(key)) continue; // já avisado para este agendamento/motivo

                        string description = s.ContainsKey("description") ? Convert.ToString(s["description"]) : "manutenção";
                        string message = BuildMessage(plate, description, reason, kmRemaining, daysRemaining, hasDueDate);
                        string sendErr;
                        bool ok = SendSms(phone, message, out sendErr);

                        Dictionary<string, object> entry = new Dictionary<string, object>();
                        entry["id"]           = Guid.NewGuid().ToString("N");
                        entry["key"]          = key;
                        entry["scheduleId"]   = scheduleId;
                        entry["vehicleId"]    = vehicleId;
                        entry["vehiclePlate"] = plate;
                        entry["empresaId"]    = empresaId;
                        entry["reason"]       = reason;
                        entry["message"]      = message;
                        entry["phone"]        = phone;
                        entry["sentAt"]       = DateTime.Now.ToString("o");
                        entry["status"]       = ok ? "enviado" : "erro";
                        if (!ok) entry["error"] = sendErr;
                        log.Add(entry);

                        if (ok) sentCount++; else errorCount++;
                    }
                }
            }

            if (sentCount > 0 || errorCount > 0)
            {
                string outJson = serializer.Serialize(db);
                FrotaRepositorio.GravarDados(outJson);
            }

            res.Write("{\"success\":true,\"sent\":" + sentCount + ",\"errors\":" + errorCount + "}");
        }
        catch (Exception ex)
        {
            res.StatusCode = 500;
            res.Write("{\"success\":false,\"error\":\"" + Escape(ex.Message) + "\"}");
        }
    }

    // ── Montagem da mensagem ────────────────────────────────────────────────
    private string BuildMessage(string plate, string description, string reason, double kmRemaining, double daysRemaining, bool hasDueDate)
    {
        if (reason == "vencida")
            return "FrotaCTL: a manutencao programada (" + description + ") do veiculo " + plate + " esta VENCIDA. Providencie o quanto antes.";

        if (reason == "km")
        {
            long km = (long)Math.Max(0, Math.Round(kmRemaining));
            return "FrotaCTL: a manutencao programada (" + description + ") do veiculo " + plate + " esta se aproximando - faltam aproximadamente " + km + " km.";
        }

        int days = hasDueDate ? (int)Math.Ceiling(Math.Max(0, daysRemaining)) : 0;
        if (days <= 0)
            return "FrotaCTL: a manutencao programada (" + description + ") do veiculo " + plate + " e HOJE. Providencie o agendamento.";
        return "FrotaCTL: a manutencao programada (" + description + ") do veiculo " + plate + " esta prevista para daqui a " + days + " dia(s).";
    }

    // ── Envio de SMS via Twilio ──────────────────────────────────────────────
    // Credenciais em web.config <appSettings>: TwilioAccountSid, TwilioAuthToken, TwilioFromNumber.
    private bool SendSms(string toPhone, string message, out string error)
    {
        error = null;
        string sid   = ConfigurationManager.AppSettings["TwilioAccountSid"];
        string token = ConfigurationManager.AppSettings["TwilioAuthToken"];
        string from  = ConfigurationManager.AppSettings["TwilioFromNumber"];

        if (string.IsNullOrWhiteSpace(sid) || string.IsNullOrWhiteSpace(token) || string.IsNullOrWhiteSpace(from))
        {
            error = "Credenciais do Twilio nao configuradas em web.config (TwilioAccountSid / TwilioAuthToken / TwilioFromNumber).";
            return false;
        }

        string to = NormalizePhone(toPhone);

        try
        {
            string url = "https://api.twilio.com/2010-04-01/Accounts/" + sid + "/Messages.json";
            using (WebClient client = new WebClient())
            {
                client.Credentials = new NetworkCredential(sid, token);
                NameValueCollection data = new NameValueCollection();
                data["To"]   = to;
                data["From"] = from;
                data["Body"] = message;
                client.UploadValues(url, "POST", data);
            }
            return true;
        }
        catch (WebException wex)
        {
            string respBody = "";
            if (wex.Response != null)
            {
                using (StreamReader sr = new StreamReader(wex.Response.GetResponseStream()))
                    respBody = sr.ReadToEnd();
            }
            error = "Erro Twilio: " + wex.Message + (string.IsNullOrEmpty(respBody) ? "" : " - " + respBody);
            return false;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }

    // Normaliza para E.164; assume Brasil (+55) quando o numero nao tem "+"
    private string NormalizePhone(string phone)
    {
        char[] digitsArr = Array.FindAll(phone.ToCharArray(), char.IsDigit);
        string digits = new string(digitsArr);
        if (phone.TrimStart().StartsWith("+")) return "+" + digits;
        return "+55" + digits;
    }

    // ── Helpers de JSON dinâmico (JavaScriptSerializer) ──────────────────────
    private Dictionary<string, object> GetDict(Dictionary<string, object> db, string key)
    {
        object val;
        if (db.TryGetValue(key, out val) && val is Dictionary<string, object>)
            return (Dictionary<string, object>)val;
        return null;
    }

    private ArrayList GetList(Dictionary<string, object> db, string key)
    {
        object val;
        if (db.TryGetValue(key, out val) && val is ArrayList)
            return (ArrayList)val;
        return null;
    }

    private string Escape(string s)
    {
        if (s == null) return "";
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", " ").Replace("\r", "");
    }

}
