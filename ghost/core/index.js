/**
 * Internal CLI Placeholder
 *
 * If we want to add alternative commands, flags, or modify environment vars, it should all go here.
 * Important: This file should not contain any requires, unless we decide to add pretty-cli/commander type tools
 *
 **/

// Don't allow NODE_ENV to be null
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const argv = process.argv;
const mode = argv[2];

if (mode === 'site-worker') {
  // A supervisor crash must not leave orphan publishing/scheduler processes.
  process.once('disconnect', () => {
    // A blocked upload/drain must not outlive the supervisor lease.
    setTimeout(() => process.exit(1), 5000).unref();
    process.kill(process.pid, 'SIGTERM');
  });
}

// Switch between boot modes
switch (mode) {
  case 'shared-tenancy':
    import('./scripts/gather-supervisor.mjs').then(module => module.startSupervisor()).catch(() => {
      console.error('Gather shared tenancy supervisor failed');
      process.exitCode = 1;
    });
    break;
  case 'repl':
  case 'timetravel':
  case 'generate-data':
    require('./core/cli/command').run(mode);
    break;
  default:
    require('./core/boot')();
}
