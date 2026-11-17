-- Y86: "Job" satırının firması değiştirilemez. Çalıştırıcı kapsamının güncelleme ilkesi (20261114120000 jobs_runner_update)
-- bütün firmaların süren işlerini yazabilir ve "companyId"ye bakmaz: süren bir iş başka firmaya taşınabiliyordu. Tetikleyici
-- her kapsamda (firma, iş, bakım, tablo sahibi) "companyId" değişikliğini reddeder; aynı değeri yazmak serbesttir.
-- Yalnız işlev ve tetikleyici eklenir; hiçbir satır okunmaz ya da güncellenmez (NO FORCE -> UPDATE -> FORCE gerekmez),
-- dolu veritabanında da sorunsuz uygulanır. Firma kimlikleri değişmez: "Job_companyId_fkey ON UPDATE CASCADE" yolu da reddedilir.
-- test/jobs.test.ts sınar.

CREATE FUNCTION "deciship"."job_company_immutable"() RETURNS trigger
  LANGUAGE plpgsql
  AS $fn$
BEGIN
  RAISE EXCEPTION 'Job.companyId cannot be changed' USING ERRCODE = 'check_violation';
END
$fn$;

CREATE TRIGGER "Job_companyId_immutable"
  BEFORE UPDATE OF "companyId" ON "deciship"."Job"
  FOR EACH ROW
  WHEN (NEW."companyId" IS DISTINCT FROM OLD."companyId")
  EXECUTE FUNCTION "deciship"."job_company_immutable"();
