import streamlit as st
import requests
import pandas as pd
from datetime import datetime

st.set_page_config(page_title="Weather Dashboard", page_icon="🌤️", layout="wide")

st.title("☁️ Interactive Weather Dashboard")
st.write("Enter a US ZIP Code to fetch real-time weather and forecast data.")

# Sidebar for input
with st.sidebar:
    st.header("Location Settings")
    zip_code = st.text_input("US ZIP Code", "10001", max_chars=5)
    unit_system = st.radio("Units", ["Fahrenheit", "Celsius"])

# Helper function to get coordinates from ZIP code
@st.cache_data
def get_coordinates(zipcode):
    try:
        response = requests.get(f"https://api.zippopotam.us/us/{zipcode}")
        if response.status_code == 200:
            data = response.json()
            place = data["places"][0]
            return {
                "lat": float(place["latitude"]),
                "lon": float(place["longitude"]),
                "city": place["place name"],
                "state": place["state abbreviation"]
            }
    except Exception:
        pass
    return None

# Helper function to get weather code interpretation
def get_weather_desc(code):
    weather_codes = {
        0: ("Clear sky", "☀️"),
        1: ("Mainly clear", "🌤️"),
        2: ("Partly cloudy", "⛅"),
        3: ("Overcast", "☁️"),
        45: ("Fog", "🌫️"),
        48: ("Depositing rime fog", "🌫️"),
        51: ("Light drizzle", "🌧️"),
        53: ("Moderate drizzle", "🌧️"),
        55: ("Dense drizzle", "🌧️"),
        61: ("Slight rain", "🌦️"),
        63: ("Moderate rain", "🌧️"),
        65: ("Heavy rain", "🌧️"),
        71: ("Slight snow", "🌨️"),
        73: ("Moderate snow", "❄️"),
        75: ("Heavy snow", "❄️"),
        95: ("Thunderstorm", "⛈️")
    }
    return weather_codes.get(code, ("Unknown", "❓"))

if zip_code and len(zip_code) == 5 and zip_code.isdigit():
    location = get_coordinates(zip_code)
    
    if location:
        st.subheader(f"📍 {location['city']}, {location['state']}")
        
        # Open-Meteo Params
        params = {
            "latitude": location["lat"],
            "longitude": location["lon"],
            "current_weather": "true",
            "hourly": "temperature_2m,precipitation,cloudcover,rain,snowfall",
            "daily": "temperature_2m_max,temperature_2m_min",
            "timezone": "auto"
        }
        
        if unit_system == "Fahrenheit":
            params["temperature_unit"] = "fahrenheit"
            params["windspeed_unit"] = "mph"
            params["precipitation_unit"] = "inch"
        
        with st.spinner("Fetching weather data..."):
            res = requests.get("https://api.open-meteo.com/v1/forecast", params=params)
            
        if res.status_code == 200:
            weather_data = res.json()
            current = weather_data["current_weather"]
            
            # --- TOP METRICS ---
            col1, col2, col3, col4 = st.columns(4)
            
            desc, icon = get_weather_desc(current["weathercode"])
            unit_sym = "°F" if unit_system == "Fahrenheit" else "°C"
            speed_sym = "mph" if unit_system == "Fahrenheit" else "km/h"
            
            with col1:
                st.metric("Temperature", f"{current['temperature']}{unit_sym}")
            with col2:
                st.metric("Condition", f"{icon} {desc}")
            with col3:
                st.metric("Wind Speed", f"{current['windspeed']} {speed_sym}")
            with col4:
                daily = weather_data["daily"]
                high = daily["temperature_2m_max"][0]
                low = daily["temperature_2m_min"][0]
                st.metric("Today's High/Low", f"{high}° / {low}°")
                
            st.divider()
            
            # --- HOURLY FORECAST CHART ---
            st.subheader("📈 24-Hour Forecast")
            hourly = weather_data["hourly"]
            
            df_hourly = pd.DataFrame({
                "Time": pd.to_datetime(hourly["time"]),
                "Temperature": hourly["temperature_2m"],
                "Precipitation": hourly["precipitation"],
                "Rain": hourly["rain"],
                "Snow": hourly["snowfall"],
                "Cloud Cover (%)": hourly["cloudcover"]
            })
            
            # Slice the next 24 hours starting from the current hour
            current_time_dt = pd.to_datetime(current["time"])
            current_idx_list = df_hourly.index[df_hourly["Time"] == current_time_dt].tolist()
            
            if current_idx_list:
                start_idx = current_idx_list[0]
                df_slice = df_hourly.iloc[start_idx:start_idx+24].copy()
            else:
                df_slice = df_hourly.head(24).copy()
                
            # Make the time more readable
            df_slice["Time"] = df_slice["Time"].dt.strftime("%I %p")
            df_slice.set_index("Time", inplace=True)
            
            # Streamlit Charts
            tab1, tab2, tab3 = st.tabs(["🌡️ Temperature", "🌧️ Precipitation (Rain/Snow)", "☁️ Cloud Cover"])
            
            with tab1:
                st.markdown("**Temperature Trend**")
                st.line_chart(df_slice["Temperature"], color="#ff2b2b")
                
            with tab2:
                st.markdown("**Precipitation Metrics**")
                st.bar_chart(df_slice[["Rain", "Snow"]], color=["#1f77b4", "#00d4ff"])
                
            with tab3:
                st.markdown("**Cloud Cover (%)**")
                st.area_chart(df_slice["Cloud Cover (%)"], color="#a0a0a0")
            
            st.caption("Data provided by [Open-Meteo](https://open-meteo.com) and [Zippopotam](https://zippopotam.us).")
            
        else:
            st.error("Failed to fetch weather data from Open-Meteo.")
    else:
        st.error("Could not find that ZIP Code. Please enter a valid US ZIP Code.")
else:
    if zip_code:
        st.warning("Please enter a 5-digit US ZIP Code.")
