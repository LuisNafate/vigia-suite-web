#include <stdio.h>
#include <string.h>
#include "esp_chip_info.h"
#include "esp_mac.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"

#define COMMAND_BUFFER_SIZE 96

static void send_identity(void) {
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    printf(
        "{\"type\":\"identity\",\"protocol\":1,\"board\":\"nodemcu-32s\","
        "\"chip\":\"ESP32\",\"mac\":\"%02X:%02X:%02X:%02X:%02X:%02X\"}\n",
        mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]
    );
    fflush(stdout);
}

static void send_status(void) {
    printf(
        "{\"type\":\"status\",\"protocol\":1,\"heap_free\":%lu,\"uptime_ms\":%lu}\n",
        (unsigned long)esp_get_free_heap_size(),
        (unsigned long)(xTaskGetTickCount() * portTICK_PERIOD_MS)
    );
    fflush(stdout);
}

static void scan_wifi(void) {
    wifi_scan_config_t config = {
        .ssid = NULL,
        .bssid = NULL,
        .channel = 0,
        .show_hidden = true,
        .scan_type = WIFI_SCAN_TYPE_ACTIVE,
        .scan_time.active.min = 80,
        .scan_time.active.max = 160,
    };

    if (esp_wifi_scan_start(&config, true) != ESP_OK) {
        printf("{\"type\":\"error\",\"code\":\"wifi_scan_failed\"}\n");
        fflush(stdout);
        return;
    }

    uint16_t count = 0;
    esp_wifi_scan_get_ap_num(&count);
    if (count > 32) count = 32;
    wifi_ap_record_t records[32];
    esp_wifi_scan_get_ap_records(&count, records);

    printf("{\"type\":\"wifi_scan_started\",\"count\":%u}\n", count);
    for (uint16_t i = 0; i < count; ++i) {
        printf(
            "{\"type\":\"wifi_ap\",\"ssid\":\"%s\",\"rssi\":%d,\"channel\":%u,"
            "\"auth\":%u,\"bssid\":\"%02X:%02X:%02X:%02X:%02X:%02X\"}\n",
            (const char *)records[i].ssid,
            records[i].rssi,
            records[i].primary,
            records[i].authmode,
            records[i].bssid[0], records[i].bssid[1], records[i].bssid[2],
            records[i].bssid[3], records[i].bssid[4], records[i].bssid[5]
        );
    }
    printf("{\"type\":\"wifi_scan_finished\",\"count\":%u}\n", count);
    fflush(stdout);
}

static void command_task(void *arg) {
    char buffer[COMMAND_BUFFER_SIZE];
    while (true) {
        if (fgets(buffer, sizeof(buffer), stdin) == NULL) {
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        buffer[strcspn(buffer, "\r\n")] = 0;

        if (strcmp(buffer, "PING") == 0) {
            printf("{\"type\":\"pong\",\"protocol\":1}\n");
            fflush(stdout);
        } else if (strcmp(buffer, "INFO") == 0) {
            send_identity();
        } else if (strcmp(buffer, "STATUS") == 0) {
            send_status();
        } else if (strcmp(buffer, "SCAN_WIFI") == 0) {
            scan_wifi();
        } else if (strcmp(buffer, "SCAN_BLE") == 0) {
            printf("{\"type\":\"not_implemented\",\"module\":\"ble\"}\n");
            fflush(stdout);
        } else if (buffer[0] != 0) {
            printf("{\"type\":\"error\",\"code\":\"unknown_command\"}\n");
            fflush(stdout);
        }
    }
}

void app_main(void) {
    esp_err_t nvs_result = nvs_flash_init();
    if (nvs_result == ESP_ERR_NVS_NO_FREE_PAGES || nvs_result == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    wifi_init_config_t wifi_config = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    ESP_ERROR_CHECK(esp_wifi_init(&wifi_config));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());

    vTaskDelay(pdMS_TO_TICKS(500));
    printf("{\"type\":\"ready\",\"protocol\":1,\"firmware\":\"0.1.0\"}\n");
    fflush(stdout);
    xTaskCreate(command_task, "command_task", 4096, NULL, 5, NULL);
}

