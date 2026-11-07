export type DatabaseDiagnosticRepository = {
  countTrackingSessions(): Promise<number>;
};

export type DatabaseDiagnostic = {
  status: "up";
  trackingSessions: number;
};

export type GetDatabaseDiagnostic = () => Promise<DatabaseDiagnostic>;

export function createGetDatabaseDiagnostic(
  repository: DatabaseDiagnosticRepository
): GetDatabaseDiagnostic {
  return async () => ({
    status: "up",
    trackingSessions: await repository.countTrackingSessions()
  });
}
