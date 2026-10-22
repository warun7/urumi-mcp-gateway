<?php
// Readiness: can we reach the database? Does not load WordPress (no canonical redirects).
header('Content-Type: text/plain');
header('Cache-Control: no-store');
mysqli_report(MYSQLI_REPORT_OFF);
$host = getenv('WORDPRESS_DB_HOST') ?: 'mariadb';
$port = 3306;
if (strpos($host, ':') !== false) { [$host, $port] = explode(':', $host, 2); $port = (int)$port; }
$db = @mysqli_connect($host, getenv('WORDPRESS_DB_USER'), getenv('WORDPRESS_DB_PASSWORD'), getenv('WORDPRESS_DB_NAME'), $port);
if (!$db) { http_response_code(503); echo "db unavailable\n"; exit; }
mysqli_close($db);
echo "ready\n";
