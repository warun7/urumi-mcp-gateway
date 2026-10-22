<?php
// Liveness: proves Apache + PHP are serving. Deliberately does NOT touch the database,
// so a DB outage makes the pod unready (traffic stops) but never restarts it.
header('Content-Type: text/plain');
header('Cache-Control: no-store');
echo "ok\n";
